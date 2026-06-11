import fs from "fs"
import path from "path"
import { DatabaseSync } from "node:sqlite"
import { config } from "./config"

export type MessageDirection = "INBOUND" | "OUTBOUND"
export type MessageKind = "MESSAGE" | "ACK"
export type MessageStatus = "PENDING" | "SENT" | "FAILED" | "RECEIVED" | "DELIVERED"
export type AckJobStatus = "PENDING" | "SENT" | "FAILED"

interface RecordMessageInput {
  messageID: string
  direction: MessageDirection
  kind: MessageKind
  peerNodeID: string
  payload: string
  status: MessageStatus
}

export interface AckRetryJob {
  id: number
  messageID: string
  senderNodeID: string
  attemptCount: number
  status: AckJobStatus
}

const DB_FILE = path.join(config.dataDir, "messages.db")
let db: DatabaseSync | null = null

function now() {
  return Date.now()
}

function getDB() {
  if (db) return db

  if (!fs.existsSync(config.dataDir)) {
    fs.mkdirSync(config.dataDir, { recursive: true })
  }

  db = new DatabaseSync(DB_FILE)
  db.exec("PRAGMA journal_mode = WAL;")
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      kind TEXT NOT NULL,
      peer_node_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(message_id, direction)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id);
    CREATE INDEX IF NOT EXISTS idx_messages_direction ON messages(direction);

    CREATE TABLE IF NOT EXISTS ack_retry_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      sender_node_id TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'PENDING',
      next_attempt_at INTEGER NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(message_id, sender_node_id)
    );

    CREATE INDEX IF NOT EXISTS idx_ack_retry_due
      ON ack_retry_jobs(status, next_attempt_at);
  `)

  return db
}

export function initDatabase() {
  getDB()
}

export function recordMessage(input: RecordMessageInput) {
  const conn = getDB()
  conn
    .prepare(
      `
      INSERT OR IGNORE INTO messages
        (message_id, direction, kind, peer_node_id, payload, status, created_at, updated_at)
      VALUES
        (@messageID, @direction, @kind, @peerNodeID, @payload, @status, @createdAt, @updatedAt)
      `
    )
    .run({
      ...input,
      createdAt: now(),
      updatedAt: now(),
    })
}

export function updateOutboundStatus(messageID: string, status: MessageStatus) {
  const conn = getDB()
  conn
    .prepare(
      `
      UPDATE messages
      SET
        status = CASE
          WHEN ? = 'SENT' AND status = 'DELIVERED' THEN status
          ELSE ?
        END,
        updated_at = ?
      WHERE message_id = ? AND direction = 'OUTBOUND'
      `
    )
    .run(status, status, now(), messageID)
}

export function markDeliveredByAck(ackedMessageID: string) {
  updateOutboundStatus(ackedMessageID, "DELIVERED")
}

export function getOutboundMessagePeer(messageID: string): string | null {
  const conn = getDB()
  const row = conn
    .prepare(
      `
      SELECT peer_node_id AS peerNodeID
      FROM messages
      WHERE message_id = ? AND direction = 'OUTBOUND'
      LIMIT 1
      `
    )
    .get(messageID) as { peerNodeID?: string } | undefined

  return row?.peerNodeID ?? null
}

export function hasInboundMessage(messageID: string): boolean {
  const conn = getDB()
  const row = conn
    .prepare(
      `
      SELECT 1 AS exists_flag
      FROM messages
      WHERE message_id = ? AND direction = 'INBOUND'
      LIMIT 1
      `
    )
    .get(messageID) as { exists_flag?: number } | undefined

  return row?.exists_flag === 1
}

export function listRecentMessages(limit = 50) {
  const conn = getDB()
  const capped = Math.max(1, Math.min(500, limit))
  return conn
    .prepare(
      `
      SELECT
        message_id AS messageID,
        direction,
        kind,
        peer_node_id AS peerNodeID,
        payload,
        status,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM messages
      ORDER BY id DESC
      LIMIT ?
      `
    )
    .all(capped)
}

export function enqueueAckRetryJob(
  messageID: string,
  senderNodeID: string,
  reason: string
) {
  const conn = getDB()
  const timestamp = now()
  conn
    .prepare(
      `
      INSERT INTO ack_retry_jobs
        (message_id, sender_node_id, attempt_count, status, next_attempt_at, last_error, created_at, updated_at)
      VALUES
        (?, ?, 0, 'PENDING', ?, ?, ?, ?)
      ON CONFLICT(message_id, sender_node_id) DO UPDATE SET
        status = 'PENDING',
        next_attempt_at = MIN(next_attempt_at, excluded.next_attempt_at),
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
      `
    )
    .run(messageID, senderNodeID, timestamp, reason, timestamp, timestamp)
}

export function listDueAckRetryJobs(limit = 20): AckRetryJob[] {
  const conn = getDB()
  const capped = Math.max(1, Math.min(200, limit))
  return conn
    .prepare(
      `
      SELECT
        id,
        message_id AS messageID,
        sender_node_id AS senderNodeID,
        attempt_count AS attemptCount,
        status
      FROM ack_retry_jobs
      WHERE status = 'PENDING' AND next_attempt_at <= ?
      ORDER BY next_attempt_at ASC, id ASC
      LIMIT ?
      `
    )
    .all(now(), capped) as unknown as AckRetryJob[]
}

export function markAckRetryJobSent(id: number) {
  const conn = getDB()
  conn
    .prepare(
      `
      UPDATE ack_retry_jobs
      SET status = 'SENT', updated_at = ?
      WHERE id = ?
      `
    )
    .run(now(), id)
}

export function markAckRetryJobFailure(
  id: number,
  reason: string,
  maxAttempts: number,
  baseBackoffMs: number,
  maxBackoffMs: number
) {
  const conn = getDB()
  const row = conn
    .prepare(
      `
      SELECT attempt_count AS attemptCount
      FROM ack_retry_jobs
      WHERE id = ?
      LIMIT 1
      `
    )
    .get(id) as { attemptCount?: number } | undefined

  const currentAttempts = row?.attemptCount ?? 0
  const nextAttempts = currentAttempts + 1
  const shouldFail = nextAttempts >= Math.max(1, maxAttempts)
  const retryDelay = Math.min(
    Math.max(1000, maxBackoffMs),
    Math.max(500, baseBackoffMs) * Math.pow(2, Math.max(0, nextAttempts - 1))
  )

  conn
    .prepare(
      `
      UPDATE ack_retry_jobs
      SET
        attempt_count = ?,
        status = ?,
        next_attempt_at = ?,
        last_error = ?,
        updated_at = ?
      WHERE id = ?
      `
    )
    .run(
      nextAttempts,
      shouldFail ? "FAILED" : "PENDING",
      now() + retryDelay,
      reason,
      now(),
      id
    )
}
