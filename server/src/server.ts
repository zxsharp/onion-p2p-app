import fs from "fs"
import express from "express"
import axios from "axios"
import { SocksProxyAgent } from "socks-proxy-agent"
import { config } from "./config"
import { initCrypto, getIdentity, sign, verify, openSealedBox } from "./crypto"
import {
  createDeliverSignaturePayload,
  createMessageID,
  Instruction,
  selectRoute,
  sendMessage,
} from "./onion"
import {
  enqueueAckRetryJob,
  listDueAckRetryJobs,
  markAckRetryJobFailure,
  markAckRetryJobSent,
  hasInboundMessage,
  getOutboundMessagePeer,
  initDatabase,
  listRecentMessages,
  markDeliveredByAck,
  recordMessage,
  updateOutboundStatus,
} from "./db"
import { PeerManager } from "./peer"

const app = express()
app.use(express.json())

const torAgent = new SocksProxyAgent(`socks5h://127.0.0.1:${config.socksPort}`)
const peerManager = new PeerManager()

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isLikelyNodeID(value: unknown): value is string {
  return isNonEmptyString(value) && /^[0-9a-f]{64}$/i.test(value)
}

function isLikelyOnionAddress(value: unknown): value is string {
  return isNonEmptyString(value) && /^[a-z2-7]{16,56}\.onion$/i.test(value)
}

function isFreshTimestamp(
  createdAt: unknown,
  maxAgeMs: number,
  maxFutureSkewMs: number
): createdAt is number {
  if (!Number.isInteger(createdAt)) return false
  const now = Date.now()
  return now - createdAt <= maxAgeMs && createdAt - now <= maxFutureSkewMs
}

function createPeerAnnouncementPayload(input: {
  nodeID: string
  onion: string
  createdAt: number
}): string {
  return JSON.stringify({
    nodeID: input.nodeID,
    onion: input.onion,
    createdAt: input.createdAt,
  })
}

function computeRelayHops(
  peers: { nodeID: string; onion: string }[],
  destinationNodeID: string,
  senderNodeID: string,
  requestedRelayHops?: number
): number {
  if (requestedRelayHops !== undefined) {
    return requestedRelayHops
  }

  const availableCandidates = peers.filter(
    peer => peer.nodeID !== destinationNodeID && peer.nodeID !== senderNodeID
  ).length
  return Math.min(Math.max(0, config.defaultRelayHops), availableCandidates)
}

// ── Endpoints ────────────────────────────────────────────────────────────────

// Peer discovery: announce yourself and receive known peers in return
app.post("/peer-request", (req, res) => {
  const { nodeID, onion, createdAt, signature } = req.body
  if (!isLikelyNodeID(nodeID) || !isLikelyOnionAddress(onion)) {
    res.status(400).json({ error: "Invalid peer announcement" })
    return
  }

  if (!isFreshTimestamp(createdAt, config.maxPeerAnnouncementAgeMs, config.maxPacketFutureSkewMs)) {
    res.status(400).json({ error: "Peer announcement expired" })
    return
  }

  if (!isNonEmptyString(signature)) {
    res.status(400).json({ error: "Missing peer announcement signature" })
    return
  }

  const isValidAnnouncement = verify(
    nodeID,
    createPeerAnnouncementPayload({ nodeID, onion, createdAt }),
    signature
  )
  if (!isValidAnnouncement) {
    res.status(400).json({ error: "Invalid peer announcement signature" })
    return
  }

  peerManager.addPeer(nodeID, onion)
  res.json({ peers: peerManager.getAllPeers() })
})

// Return current peer table for debugging and sender-side path selection
app.get("/peers", (_req, res) => {
  res.json({ peers: peerManager.getAllPeers() })
})

// Local node message history from SQLite store
app.get("/messages", (req, res) => {
  const parsedLimit = Number.parseInt(String(req.query.limit ?? "50"), 10)
  const limit = Number.isNaN(parsedLimit) ? 50 : parsedLimit
  res.json({ messages: listRecentMessages(limit) })
})

// Build route and dispatch an onion packet to destination through relay hops
app.post("/send", async (req, res) => {
  const { destinationNodeID, message, relayHops, ttl } = req.body
  const messageID = createMessageID()

  if (!isLikelyNodeID(destinationNodeID) || !isNonEmptyString(message)) {
    res.status(400).json({ error: "destinationNodeID and message are required" })
    return
  }

  if (relayHops !== undefined && (!Number.isInteger(relayHops) || relayHops < 0)) {
    res.status(400).json({ error: "relayHops must be a non-negative integer" })
    return
  }

  if (ttl !== undefined && (!Number.isInteger(ttl) || ttl < 1)) {
    res.status(400).json({ error: "ttl must be a positive integer" })
    return
  }

  try {
    const identity = getIdentity()
    const peers = peerManager.getAllPeers()
    recordMessage({
      messageID,
      direction: "OUTBOUND",
      kind: "MESSAGE",
      peerNodeID: destinationNodeID,
      payload: message,
      status: "PENDING",
    })

    const route = selectRoute(peers, destinationNodeID, {
      relayHops: computeRelayHops(peers, destinationNodeID, identity.publicKey, relayHops),
      senderNodeID: identity.publicKey,
    })

    await sendMessage(route, message, identity, {
      ttl,
      messageID,
      kind: "MESSAGE",
    })

    updateOutboundStatus(messageID, "SENT")

    res.json({
      ok: true,
      messageID,
      relayCount: route.length - 1,
      route: route.map(hop => ({ nodeID: hop.nodeID, onion: hop.onion })),
    })
  } catch (err) {
    updateOutboundStatus(messageID, "FAILED")
    const msg = err instanceof Error ? err.message : "Could not send message"
    res.status(400).json({ error: msg })
  }
})

// Relay: peel one encryption layer, then forward (RELAY) or deliver (DELIVER)
app.post("/relay", async (req, res) => {
  const { data } = req.body
  try {
    const identity = getIdentity()
    const plaintext = openSealedBox(identity.publicKey, identity.privateKey, data)
    const instruction: Instruction = JSON.parse(plaintext)

    if (instruction.type === "RELAY") {
      if (!Number.isInteger(instruction.ttl) || instruction.ttl < 1) {
        res.status(400).json({ error: "Packet TTL expired" })
        return
      }
      if (!isLikelyOnionAddress(instruction.next)) {
        res.status(400).json({ error: "Invalid relay target" })
        return
      }
      if (config.enforceKnownRelayTargets && !peerManager.hasOnion(instruction.next)) {
        res.status(403).json({ error: "Relay target is not trusted" })
        return
      }

      await axios.post(
        `http://${instruction.next}/relay`,
        { data: instruction.payload },
        { httpAgent: torAgent }
      )
      res.json({ ok: true })
    } else if (instruction.type === "DELIVER") {
      const valid = verify(
        instruction.from,
        createDeliverSignaturePayload({
          kind: instruction.kind,
          messageID: instruction.messageID,
          createdAt: instruction.createdAt,
          from: instruction.from,
          payload: instruction.payload,
        }),
        instruction.signature
      )
      if (!valid) {
        res.status(400).json({ error: "Invalid signature" })
        return
      }

      if (!isFreshTimestamp(instruction.createdAt, config.maxPacketAgeMs, config.maxPacketFutureSkewMs)) {
        res.status(400).json({ error: "Packet expired" })
        return
      }

      if (instruction.kind === "ACK") {
        const expectedPeerNodeID = getOutboundMessagePeer(instruction.payload)
        if (!expectedPeerNodeID) {
          res.status(404).json({ error: "Unknown acked message" })
          return
        }
        if (expectedPeerNodeID !== instruction.from) {
          res.status(400).json({ error: "Ack sender mismatch" })
          return
        }

        markDeliveredByAck(instruction.payload)
        recordMessage({
          messageID: instruction.messageID,
          direction: "INBOUND",
          kind: "ACK",
          peerNodeID: instruction.from,
          payload: instruction.payload,
          status: "RECEIVED",
        })
        console.log(`[ACK] Message delivered confirmation for ${instruction.payload}`)
        res.json({ ok: true })
        return
      }

      if (!hasInboundMessage(instruction.messageID)) {
        recordMessage({
          messageID: instruction.messageID,
          direction: "INBOUND",
          kind: "MESSAGE",
          peerNodeID: instruction.from,
          payload: instruction.payload,
          status: "RECEIVED",
        })
      }

      console.log(`[DELIVER] From ${instruction.from}: ${instruction.payload}`)

      const senderPeer = peerManager.getPeer(instruction.from)
      if (senderPeer) {
        try {
          const identity = getIdentity()
          const peers = peerManager.getAllPeers()
          const ackRelayHops = computeRelayHops(
            peers,
            instruction.from,
            identity.publicKey
          )
          const ackRoute = selectRoute(peers, instruction.from, {
            senderNodeID: identity.publicKey,
            relayHops: ackRelayHops,
          })

          await sendMessage(ackRoute, instruction.messageID, identity, {
            kind: "ACK",
            ttl: config.defaultPacketTtl,
          })
          console.log(`[ACK] Sent ack for message ${instruction.messageID} to ${instruction.from}`)
        } catch (ackErr) {
          enqueueAckRetryJob(
            instruction.messageID,
            instruction.from,
            ackErr instanceof Error ? ackErr.message : "Ack send failed"
          )
          console.warn(`[ACK] Failed to send ack for ${instruction.messageID}:`, ackErr)
        }
      } else {
        enqueueAckRetryJob(instruction.messageID, instruction.from, "Sender peer unknown")
        console.warn(`[ACK] Sender peer ${instruction.from} not known, ack skipped`)
      }

      res.json({ ok: true })
    } else {
      res.status(400).json({ error: "Unknown instruction type" })
    }
  } catch {
    // Don't leak decryption failure details to the network
    res.status(400).json({ error: "Could not process packet" })
  }
})

// ── Bootstrap ────────────────────────────────────────────────────────────────

async function requestPeers(targetOnion: string, myOnion: string) {
  const identity = getIdentity()
  const createdAt = Date.now()
  const signature = sign(
    identity.privateKey,
    createPeerAnnouncementPayload({
      nodeID: identity.publicKey,
      onion: myOnion,
      createdAt,
    })
  )
  const res = await axios.post(
    `http://${targetOnion}/peer-request`,
    {
      nodeID: identity.publicKey,
      onion: myOnion,
      createdAt,
      signature,
    },
    { httpAgent: torAgent }
  )
  res.data.peers.forEach((p: { nodeID: string; onion: string }) =>
    peerManager.addPeer(p.nodeID, p.onion)
  )
}

async function sendAckForMessage(messageID: string, senderNodeID: string) {
  const identity = getIdentity()
  const peers = peerManager.getAllPeers()
  const ackRelayHops = computeRelayHops(peers, senderNodeID, identity.publicKey)
  const ackRoute = selectRoute(peers, senderNodeID, {
    senderNodeID: identity.publicKey,
    relayHops: ackRelayHops,
  })

  await sendMessage(ackRoute, messageID, identity, {
    kind: "ACK",
    ttl: config.defaultPacketTtl,
  })
}

function startAckRetryWorker() {
  let inFlight = false

  setInterval(async () => {
    if (inFlight) return
    inFlight = true
    try {
      const jobs = listDueAckRetryJobs(20)
      for (const job of jobs) {
        try {
          await sendAckForMessage(job.messageID, job.senderNodeID)
          markAckRetryJobSent(job.id)
          console.log(`[ACK-RETRY] Sent ack for message ${job.messageID} after retry`)
        } catch (err) {
          markAckRetryJobFailure(
            job.id,
            err instanceof Error ? err.message : "Ack retry failed",
            config.ackRetryMaxAttempts,
            config.ackRetryBaseBackoffMs,
            config.ackRetryMaxBackoffMs
          )
          console.warn(`[ACK-RETRY] Failed ack retry for ${job.messageID}:`, err)
        }
      }
    } finally {
      inFlight = false
    }
  }, Math.max(1000, config.ackRetryPollMs))
}

async function main() {
  await initCrypto()
  initDatabase()
  peerManager.loadPeers()
  startAckRetryWorker()

  const identity = getIdentity()
  console.log("Node ID:", identity.publicKey)

  let myOnion = "<unknown>"
  try {
    myOnion = fs
      .readFileSync(`${config.hiddenServiceDir}/hostname`, "utf8")
      .trim()
    console.log("Onion address:", myOnion)
  } catch {
    console.warn(
      "Could not read hidden_service/hostname – Tor may not be running yet.\n" +
      "Set HIDDEN_SERVICE_DIR env var if the path differs."
    )
  }

  app.listen(config.httpPort, () =>
    console.log(`Node listening on :${config.httpPort}`)
  )

  for (const bootstrapOnion of config.bootstrapOnions) {
    if (!isLikelyOnionAddress(myOnion)) {
      console.warn("Skipping bootstrap: local onion hostname is not available yet")
      break
    }

    try {
      await requestPeers(bootstrapOnion, myOnion)
      console.log(
        `Peers after bootstrap from ${bootstrapOnion}:`,
        peerManager.getAllPeers()
      )
    } catch (err) {
      console.error(`Peer discovery from ${bootstrapOnion} failed:`, err)
    }
  }
}

main()