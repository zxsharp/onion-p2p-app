import fs from "fs"
import path from "path"
import { DatabaseSync } from "node:sqlite"
import { config } from "./config"

export type MessageDirection = "INBOUND" | "OUTBOUND"
export type MessageKind = "MESSAGE" | "ACK"
export type MessageStatus = "PENDING" | "SENT" | "FAILED" | "RECEIVED" | "DELIVERED"

interface RecordMessageInput {
  messageID: string
  direction: MessageDirection
  kind: MessageKind
  peerNodeID: string
  payload: string
  status: MessageStatus
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
