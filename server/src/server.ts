import fs from "fs"
import express from "express"
import axios from "axios"
import { SocksProxyAgent } from "socks-proxy-agent"
import { config } from "./config"
import { initCrypto, getIdentity, verify, openSealedBox } from "./crypto"
import {
  hasInboundMessage,
  initDatabase,
  listRecentMessages,
  markDeliveredByAck,
  recordMessage,
  updateOutboundStatus,
} from "./db"
import { PeerManager } from "./peer"
import { createMessageID, Instruction, selectRoute, sendMessage } from "./onion"

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

// ── Endpoints ────────────────────────────────────────────────────────────────

// Peer discovery: announce yourself and receive known peers in return
app.post("/peer-request", (req, res) => {
  const { nodeID, onion } = req.body
  if (!isLikelyNodeID(nodeID) || !isNonEmptyString(onion)) {
    res.status(400).json({ error: "Invalid peer announcement" })
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

  if (relayHops !== undefined && (!Number.isInteger(relayHops) || relayHops < 1)) {
    res.status(400).json({ error: "relayHops must be a positive integer" })
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
      relayHops,
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

      await axios.post(
        `http://${instruction.next}/relay`,
        { data: instruction.payload },
        { httpAgent: torAgent }
      )
      res.json({ ok: true })
    } else if (instruction.type === "DELIVER") {
      const valid = verify(instruction.from, instruction.payload, instruction.signature)
      if (!valid) {
        res.status(400).json({ error: "Invalid signature" })
        return
      }

      if (instruction.kind === "ACK") {
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
          const ackRoute = selectRoute(peerManager.getAllPeers(), instruction.from, {
            senderNodeID: identity.publicKey,
            relayHops: config.defaultRelayHops,
          })

          await sendMessage(ackRoute, instruction.messageID, identity, {
            kind: "ACK",
            ttl: config.defaultPacketTtl,
          })
          console.log(`[ACK] Sent ack for message ${instruction.messageID} to ${instruction.from}`)
        } catch (ackErr) {
          console.warn(`[ACK] Failed to send ack for ${instruction.messageID}:`, ackErr)
        }
      } else {
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
  const res = await axios.post(
    `http://${targetOnion}/peer-request`,
    { nodeID: identity.publicKey, onion: myOnion },
    { httpAgent: torAgent }
  )
  res.data.peers.forEach((p: { nodeID: string; onion: string }) =>
    peerManager.addPeer(p.nodeID, p.onion)
  )
}

async function main() {
  await initCrypto()
  initDatabase()
  peerManager.loadPeers()

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