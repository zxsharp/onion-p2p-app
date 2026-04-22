import fs from "fs"
import os from "os"
import path from "path"

let passed = 0
let failed = 0

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  [ok] ${label}`)
    passed++
  } else {
    console.error(`  [fail] ${label}`)
    failed++
  }
}

function assertThrows(fn: () => void, label: string) {
  let threw = false
  try {
    fn()
  } catch {
    threw = true
  }
  assert(threw, label)
}

type TestNode = {
  name: string
  onion: string
  publicKey: string
  privateKey: string
}

type RelayInstruction = {
  type: "RELAY"
  next: string
  ttl: number
  payload: string
}

type DeliverInstruction = {
  type: "DELIVER"
  kind: "MESSAGE" | "ACK"
  messageID: string
  createdAt: number
  from: string
  payload: string
  signature: string
}

function makeOnion(label: string) {
  // 16-char v2 style hostname format for test validation paths.
  return `${label.repeat(16).slice(0, 16)}.onion`
}

async function run() {
  console.log("\n== Integration-like protocol tests (multi-node simulation) ==")

  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "onion-p2p-it-"))
  process.env.DATA_DIR = tempDataDir
  process.env.DEFAULT_RELAY_HOPS = "2"
  process.env.DEFAULT_PACKET_TTL = "8"

  const crypto = await import("./crypto")
  const onion = await import("./onion")
  const db = await import("./db")
  const peerMod = await import("./peer")

  await crypto.initCrypto()
  db.initDatabase()

  const senderIdentity = crypto.getIdentity()

  const nodeB = crypto.generateKeypair()
  const nodeC = crypto.generateKeypair()
  const nodeD = crypto.generateKeypair()
  const attacker = crypto.generateKeypair()

  const sender: TestNode = {
    name: "sender",
    onion: makeOnion("a"),
    publicKey: senderIdentity.publicKey,
    privateKey: senderIdentity.privateKey,
  }
  const relayB: TestNode = {
    name: "relayB",
    onion: makeOnion("b"),
    publicKey: nodeB.publicKey,
    privateKey: nodeB.privateKey,
  }
  const relayC: TestNode = {
    name: "relayC",
    onion: makeOnion("c"),
    publicKey: nodeC.publicKey,
    privateKey: nodeC.privateKey,
  }
  const destination: TestNode = {
    name: "destination",
    onion: makeOnion("d"),
    publicKey: nodeD.publicKey,
    privateKey: nodeD.privateKey,
  }
  const attackerNode: TestNode = {
    name: "attacker",
    onion: makeOnion("e"),
    publicKey: attacker.publicKey,
    privateKey: attacker.privateKey,
  }

  const nodesByOnion = new Map<string, TestNode>([
    [sender.onion, sender],
    [relayB.onion, relayB],
    [relayC.onion, relayC],
    [destination.onion, destination],
    [attackerNode.onion, attackerNode],
  ])

  function deliverAcrossRoute(startOnion: string, packet: string) {
    let currentOnion = startOnion
    let currentPacket = packet

    for (let hop = 0; hop < 16; hop++) {
      const currentNode = nodesByOnion.get(currentOnion)
      if (!currentNode) {
        throw new Error(`Unknown onion target during simulation: ${currentOnion}`)
      }

      const plaintext = crypto.openSealedBox(
        currentNode.publicKey,
        currentNode.privateKey,
        currentPacket
      )
      const instruction = JSON.parse(plaintext) as RelayInstruction | DeliverInstruction

      if (instruction.type === "RELAY") {
        if (!Number.isInteger(instruction.ttl) || instruction.ttl < 1) {
          throw new Error("Packet TTL expired")
        }
        currentOnion = instruction.next
        currentPacket = instruction.payload
        continue
      }

      const valid = crypto.verify(
        instruction.from,
        onion.createDeliverSignaturePayload({
          kind: instruction.kind,
          messageID: instruction.messageID,
          createdAt: instruction.createdAt,
          from: instruction.from,
          payload: instruction.payload,
        }),
        instruction.signature
      )
      if (!valid) {
        throw new Error("Invalid signature")
      }

      return {
        receiver: currentNode,
        instruction,
      }
    }

    throw new Error("Too many hops while relaying packet")
  }

  function outboundStatus(messageID: string): string | null {
    const row = (db.listRecentMessages(500) as Array<any>).find(
      m => m.messageID === messageID && m.direction === "OUTBOUND"
    )
    return row?.status ?? null
  }

  console.log("\n-- Peer discovery/update and persistence --")
  const peerManager = new peerMod.PeerManager()
  peerManager.addPeer(relayB.publicKey, relayB.onion)
  peerManager.addPeer(relayB.publicKey, relayC.onion)
  assert(
    peerManager.getPeer(relayB.publicKey)?.onion === relayC.onion,
    "peer update replaces onion for existing node id"
  )

  const reloadedManager = new peerMod.PeerManager()
  reloadedManager.loadPeers()
  assert(
    reloadedManager.getPeer(relayB.publicKey)?.onion === relayC.onion,
    "peer data persists to local storage"
  )

  console.log("\n-- Route setup, encryption, relay exchange, ack, and db lifecycle --")
  const peers = [
    { nodeID: sender.publicKey, onion: sender.onion },
    { nodeID: relayB.publicKey, onion: relayB.onion },
    { nodeID: relayC.publicKey, onion: relayC.onion },
    { nodeID: destination.publicKey, onion: destination.onion },
  ]

  const outboundMessage = "integration hello"
  const outboundMessageID = onion.createMessageID()

  db.recordMessage({
    messageID: outboundMessageID,
    direction: "OUTBOUND",
    kind: "MESSAGE",
    peerNodeID: destination.publicKey,
    payload: outboundMessage,
    status: "PENDING",
  })

  const routeToDestination = onion.selectRoute(peers, destination.publicKey, {
    relayHops: 2,
    senderNodeID: sender.publicKey,
  })
  assert(routeToDestination.length === 3, "route includes two relays and destination")
  assert(
    routeToDestination[routeToDestination.length - 1].nodeID === destination.publicKey,
    "destination is final hop"
  )

  const onionPacket = onion.buildOnion(routeToDestination, outboundMessage, sender, {
    kind: "MESSAGE",
    messageID: outboundMessageID,
    ttl: 4,
  })

  const deliveredMessage = deliverAcrossRoute(routeToDestination[0].onion, onionPacket)
  assert(
    deliveredMessage.receiver.publicKey === destination.publicKey,
    "packet reaches intended destination after relay traversal"
  )
  assert(
    deliveredMessage.instruction.kind === "MESSAGE" && deliveredMessage.instruction.payload === outboundMessage,
    "destination receives original plaintext message"
  )

  db.updateOutboundStatus(outboundMessageID, "SENT")
  assert(outboundStatus(outboundMessageID) === "SENT", "outbound message transitions to SENT")

  if (!db.hasInboundMessage(deliveredMessage.instruction.messageID)) {
    db.recordMessage({
      messageID: deliveredMessage.instruction.messageID,
      direction: "INBOUND",
      kind: "MESSAGE",
      peerNodeID: deliveredMessage.instruction.from,
      payload: deliveredMessage.instruction.payload,
      status: "RECEIVED",
    })
  }
  if (!db.hasInboundMessage(deliveredMessage.instruction.messageID)) {
    db.recordMessage({
      messageID: deliveredMessage.instruction.messageID,
      direction: "INBOUND",
      kind: "MESSAGE",
      peerNodeID: deliveredMessage.instruction.from,
      payload: deliveredMessage.instruction.payload,
      status: "RECEIVED",
    })
  }
  const inboundCopies = (db.listRecentMessages(500) as Array<any>).filter(
    m => m.messageID === deliveredMessage.instruction.messageID && m.direction === "INBOUND"
  )
  assert(inboundCopies.length === 1, "inbound message is deduplicated in local storage")

  const spoofAckRoute = [{ nodeID: sender.publicKey, onion: sender.onion }]
  const spoofAckPacket = onion.buildOnion(spoofAckRoute, outboundMessageID, attackerNode, {
    kind: "ACK",
    messageID: onion.createMessageID(),
    ttl: 1,
  })
  const spoofAckDelivered = deliverAcrossRoute(sender.onion, spoofAckPacket)
  const expectedPeerForAck = db.getOutboundMessagePeer(spoofAckDelivered.instruction.payload)
  const spoofAckAccepted = expectedPeerForAck === spoofAckDelivered.instruction.from
  assert(!spoofAckAccepted, "spoofed ack from wrong sender is rejected by peer binding")
  assert(outboundStatus(outboundMessageID) === "SENT", "spoofed ack does not mark outbound message delivered")

  const ackRoute = onion.selectRoute(peers, sender.publicKey, {
    relayHops: 1,
    senderNodeID: destination.publicKey,
  })
  const ackPacket = onion.buildOnion(ackRoute, outboundMessageID, destination, {
    kind: "ACK",
    messageID: onion.createMessageID(),
    ttl: 3,
  })
  const ackDelivered = deliverAcrossRoute(ackRoute[0].onion, ackPacket)
  const expectedAckPeer = db.getOutboundMessagePeer(ackDelivered.instruction.payload)
  if (expectedAckPeer === ackDelivered.instruction.from) {
    db.markDeliveredByAck(ackDelivered.instruction.payload)
    db.recordMessage({
      messageID: ackDelivered.instruction.messageID,
      direction: "INBOUND",
      kind: "ACK",
      peerNodeID: ackDelivered.instruction.from,
      payload: ackDelivered.instruction.payload,
      status: "RECEIVED",
    })
  }
  assert(outboundStatus(outboundMessageID) === "DELIVERED", "valid ack marks outbound message DELIVERED")

  console.log("\n-- TTL behavior --")
  assertThrows(
    () => onion.buildOnion(routeToDestination, "ttl-low", sender, { ttl: 1 }),
    "buildOnion rejects ttl lower than required relay depth"
  )

  const expiredRelayPayload = crypto.sealedBox(
    relayB.publicKey,
    JSON.stringify({
      type: "RELAY",
      next: destination.onion,
      ttl: 0,
      payload: "ignored",
    } satisfies RelayInstruction)
  )
  assertThrows(
    () => deliverAcrossRoute(relayB.onion, expiredRelayPayload),
    "relay processing rejects packet with expired ttl"
  )

  console.log("\n== Result summary ==")
  console.log(`passed=${passed} failed=${failed}`)
  if (failed > 0) {
    process.exit(1)
  }
}

run().catch(err => {
  console.error("Unexpected integration test error:", err)
  process.exit(1)
})
