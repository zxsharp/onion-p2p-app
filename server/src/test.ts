/**
 * Local test suite – no Tor, no network, no running servers required.
 *
 * Run:  pnpm test
 *
 * Tests:
 *  1. initCrypto
 *  2. sign / verify
 *  3. sign with wrong key → should fail
 *  4. sealedBox / openSealedBox
 *  5. openSealedBox with wrong key → should throw
 *  6. buildOnion + full layer-by-layer peel (3 hops: relay → relay → destination)
 *     - intermediate nodes see only RELAY + next onion, never the message
 *     - only the destination sees DELIVER + can verify the sender signature
 */

import {
  initCrypto,
  getIdentity,
  generateKeypair,
  sign,
  verify,
  sealedBox,
  openSealedBox,
} from "./crypto"
import { buildOnion, createDeliverSignaturePayload, selectRoute } from "./onion"

let passed = 0
let failed = 0

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ FAIL: ${label}`)
    failed++
  }
}

async function run() {
  console.log("\n── Initialising libsodium ──────────────────────────────")
  await initCrypto()
  assert(true, "initCrypto()")

  // ── 1. Identity ────────────────────────────────────────────────────────────
  console.log("\n── Identity ────────────────────────────────────────────")
  const sender = getIdentity()
  assert(typeof sender.publicKey === "string" && sender.publicKey.length === 64, "getIdentity() returns 32-byte hex public key")
  assert(typeof sender.privateKey === "string" && sender.privateKey.length === 128, "getIdentity() returns 64-byte hex private key")

  const ephemeral = generateKeypair()
  assert(ephemeral.publicKey.length === 64, "generateKeypair() public key is 32 bytes hex")
  assert(ephemeral.publicKey !== sender.publicKey, "generateKeypair() produces fresh key")

  // ── 2. Sign / Verify ───────────────────────────────────────────────────────
  console.log("\n── sign / verify ───────────────────────────────────────")
  const message = "hello from node"
  const sig = sign(sender.privateKey, message)
  assert(typeof sig === "string" && sig.length === 128, "sign() returns 64-byte hex signature")

  const validSig = verify(sender.publicKey, message, sig)
  assert(validSig, "verify() accepts correct signature")

  const wrongKey = generateKeypair()
  const invalidSig = verify(wrongKey.publicKey, message, sig)
  assert(!invalidSig, "verify() rejects signature from a different key")

  const tamperedMsg = verify(sender.publicKey, message + "!", sig)
  assert(!tamperedMsg, "verify() rejects signature over tampered message")

  // ── 3. sealedBox / openSealedBox ───────────────────────────────────────────
  console.log("\n── sealedBox / openSealedBox ───────────────────────────")
  const nodeB = generateKeypair()
  const ciphertext = sealedBox(nodeB.publicKey, message)
  assert(typeof ciphertext === "string", "sealedBox() returns base64 string")
  assert(ciphertext !== message, "sealedBox() output is not plaintext")

  const decrypted = openSealedBox(nodeB.publicKey, nodeB.privateKey, ciphertext)
  assert(decrypted === message, "openSealedBox() recovers original message")

  let threw = false
  try {
    openSealedBox(wrongKey.publicKey, wrongKey.privateKey, ciphertext)
  } catch {
    threw = true
  }
  assert(threw, "openSealedBox() throws when wrong key is used")

  // ── 4. buildOnion + layer-by-layer peel ───────────────────────────────────
  console.log("\n── buildOnion (3-hop: A → B → C → D) ──────────────────")

  // Four participants: sender A (real identity) + three mock nodes
  const nodeC = generateKeypair()
  const nodeD = generateKeypair() // final destination

  const hops = [
    { nodeID: nodeB.publicKey, onion: "b-fake.onion" },
    { nodeID: nodeC.publicKey, onion: "c-fake.onion" },
    { nodeID: nodeD.publicKey, onion: "d-fake.onion" },   // destination
  ]

  const packet = buildOnion(hops, message, sender, { ttl: 5, messageID: "msg-test-1" })
  assert(typeof packet === "string", "buildOnion() returns a string")
  assert(!packet.includes(message), "outer packet does not contain plaintext message")

  // Hop 1: nodeB peels its layer
  const layer1Text = openSealedBox(nodeB.publicKey, nodeB.privateKey, packet)
  const layer1 = JSON.parse(layer1Text)
  assert(layer1.type === "RELAY",         "Layer 1 (nodeB) sees RELAY instruction")
  assert(layer1.next === "c-fake.onion",  "Layer 1 next hop points to nodeC")
  assert(layer1.ttl === 5,                  "Layer 1 carries configured ttl")
  assert(!layer1.payload.includes(message), "Layer 1 payload is still opaque (not plaintext)")

  // nodeB cannot peel further (it doesn't have nodeC's key)
  let nodeBCannotPeelDeeper = false
  try {
    openSealedBox(nodeB.publicKey, nodeB.privateKey, layer1.payload)
  } catch {
    nodeBCannotPeelDeeper = true
  }
  assert(nodeBCannotPeelDeeper, "nodeB cannot decrypt the inner layer (proves layered privacy)")

  // Hop 2: nodeC peels its layer
  const layer2Text = openSealedBox(nodeC.publicKey, nodeC.privateKey, layer1.payload)
  const layer2 = JSON.parse(layer2Text)
  assert(layer2.type === "RELAY",         "Layer 2 (nodeC) sees RELAY instruction")
  assert(layer2.next === "d-fake.onion",  "Layer 2 next hop points to nodeD")

  // Hop 3: nodeD peels final layer (destination)
  const layer3Text = openSealedBox(nodeD.publicKey, nodeD.privateKey, layer2.payload)
  const layer3 = JSON.parse(layer3Text)
  assert(layer3.type === "DELIVER",       "Layer 3 (nodeD) sees DELIVER instruction")
  assert(layer3.kind === "MESSAGE",        "Layer 3 deliver kind is MESSAGE")
  assert(layer3.messageID === "msg-test-1", "Layer 3 includes messageID")
  assert(layer3.payload === message,      "nodeD receives the original message")
  assert(layer3.from === sender.publicKey,"nodeD knows sender's public key")

  const deliverSigValid = verify(
    layer3.from,
    createDeliverSignaturePayload({
      kind: layer3.kind,
      messageID: layer3.messageID,
      createdAt: layer3.createdAt,
      from: layer3.from,
      payload: layer3.payload,
    }),
    layer3.signature
  )
  assert(deliverSigValid, "nodeD can verify sender's Ed25519 signature")

  // Confirm nodeC (intermediate) cannot verify — it never had the DELIVER layer
  // (already proven by layer2 being a RELAY, but let's be explicit)
  assert(layer2.type !== "DELIVER", "nodeC (intermediate) never receives a DELIVER instruction")

  // ── 5. Route selection ─────────────────────────────────────────────────────
  console.log("\n── selectRoute ───────────────────────────────────────────")

  const allPeers = [
    { nodeID: sender.publicKey, onion: "sender-fake.onion" },
    { nodeID: nodeB.publicKey, onion: "b-fake.onion" },
    { nodeID: nodeC.publicKey, onion: "c-fake.onion" },
    { nodeID: nodeD.publicKey, onion: "d-fake.onion" },
  ]

  const chosenRoute = selectRoute(allPeers, nodeD.publicKey, {
    relayHops: 2,
    senderNodeID: sender.publicKey,
  })
  assert(chosenRoute.length === 3, "selectRoute() returns relayHops + destination")
  assert(chosenRoute[chosenRoute.length - 1].nodeID === nodeD.publicKey, "selectRoute() keeps destination as final hop")

  const hasSenderInRoute = chosenRoute.some(h => h.nodeID === sender.publicKey)
  assert(!hasSenderInRoute, "selectRoute() excludes sender from relays")

  const directRoute = selectRoute(allPeers, nodeD.publicKey, {
    relayHops: 0,
    senderNodeID: sender.publicKey,
  })
  assert(directRoute.length === 1, "selectRoute() supports direct destination route when relayHops is 0")

  let missingDestThrew = false
  try {
    selectRoute(allPeers, "f".repeat(64), { relayHops: 1, senderNodeID: sender.publicKey })
  } catch {
    missingDestThrew = true
  }
  assert(missingDestThrew, "selectRoute() throws when destination is unknown")

  let tooManyRelaysThrew = false
  try {
    selectRoute(allPeers, nodeD.publicKey, { relayHops: 10, senderNodeID: sender.publicKey })
  } catch {
    tooManyRelaysThrew = true
  }
  assert(tooManyRelaysThrew, "selectRoute() throws when relay peers are insufficient")

  let negativeRelaysThrew = false
  try {
    selectRoute(allPeers, nodeD.publicKey, { relayHops: -1, senderNodeID: sender.publicKey })
  } catch {
    negativeRelaysThrew = true
  }
  assert(negativeRelaysThrew, "selectRoute() rejects negative relay count")

  let duplicateHopThrew = false
  try {
    buildOnion(
      [
        { nodeID: nodeB.publicKey, onion: "b-fake.onion" },
        { nodeID: nodeB.publicKey, onion: "b2-fake.onion" },
      ],
      message,
      sender
    )
  } catch {
    duplicateHopThrew = true
  }
  assert(duplicateHopThrew, "buildOnion() rejects duplicate nodeIDs in route")

  let lowTtlThrew = false
  try {
    buildOnion(hops, message, sender, { ttl: 1, messageID: "msg-test-low-ttl" })
  } catch {
    lowTtlThrew = true
  }
  assert(lowTtlThrew, "buildOnion() rejects ttl values that cannot cover relay depth")

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n── Results: ${passed} passed, ${failed} failed ─────────────────`)
  if (failed > 0) process.exit(1)
}

run().catch(err => {
  console.error("Unexpected error:", err)
  process.exit(1)
})
