import axios from "axios"
import { randomUUID } from "crypto"
import { SocksProxyAgent } from "socks-proxy-agent"
import { config } from "./config"
import { sign, sealedBox } from "./crypto"

export interface Hop {
  nodeID: string
  onion: string
}

export interface RelayInstruction {
  type: "RELAY"
  next: string    // onion address of the next hop
  ttl: number     // packet ttl checked by the current relay hop
  payload: string // base64-encoded sealed packet for the next hop
}

export type DeliverKind = "MESSAGE" | "ACK"

export interface DeliverInstruction {
  type: "DELIVER"
  kind: DeliverKind
  messageID: string
  createdAt: number
  from: string      // sender's nodeID (public key hex)
  payload: string   // plaintext message
  signature: string // Ed25519 signature over payload, verifiable only by the destination
}

export type Instruction = RelayInstruction | DeliverInstruction

export function createDeliverSignaturePayload(input: {
  kind: DeliverKind
  messageID: string
  createdAt: number
  from: string
  payload: string
}): string {
  return JSON.stringify({
    kind: input.kind,
    messageID: input.messageID,
    createdAt: input.createdAt,
    from: input.from,
    payload: input.payload,
  })
}

export function createMessageID(): string {
  return randomUUID()
}

function assertValidHops(hops: Hop[]) {
  if (!Array.isArray(hops) || hops.length === 0) {
    throw new Error("At least one hop is required")
  }

  const seen = new Set<string>()
  for (const hop of hops) {
    if (!hop.nodeID || !hop.onion) {
      throw new Error("Every hop must include nodeID and onion")
    }
    if (seen.has(hop.nodeID)) {
      throw new Error("Route cannot contain duplicate nodeIDs")
    }
    seen.add(hop.nodeID)
  }
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

/**
 * Select a route that ends at destination and includes N random relay hops.
 * Returned array always has destination as the final element.
 */
export function selectRoute(
  peers: Hop[],
  destinationNodeID: string,
  options?: {
    relayHops?: number
    senderNodeID?: string
  }
): Hop[] {
  const destination = peers.find(p => p.nodeID === destinationNodeID)
  if (!destination) {
    throw new Error("Destination peer not found")
  }

  const relayHops =
    options?.relayHops ?? Math.max(0, config.defaultRelayHops)

  if (!Number.isInteger(relayHops) || relayHops < 0) {
    throw new Error("relayHops must be a non-negative integer")
  }

  const candidates = peers.filter(
    p => p.nodeID !== destinationNodeID && p.nodeID !== options?.senderNodeID
  )

  if (candidates.length < relayHops) {
    throw new Error(
      `Not enough relay peers: requested ${relayHops}, available ${candidates.length}`
    )
  }

  const relays = shuffle(candidates).slice(0, relayHops)
  const route = [...relays, destination]
  assertValidHops(route)
  return route
}

/**
 * Build a layered-encrypted onion packet.
 *
 * hops:    [firstRelay, ..., destination]  – every node the packet should traverse
 * message: plaintext to deliver to the final destination
 * sender:  the sending node's keypair (used to sign the payload)
 *
 * Each hop can only peel its own layer; intermediate nodes see only the next
 * hop address and an opaque ciphertext — never the message or the sender.
 */
export function buildOnion(
  hops: Hop[],
  message: string,
  sender: { publicKey: string; privateKey: string },
  options?: {
    ttl?: number
    messageID?: string
    kind?: DeliverKind
  }
): string {
  assertValidHops(hops)

  const ttl = options?.ttl ?? Math.max(1, config.defaultPacketTtl)
  if (!Number.isInteger(ttl) || ttl < 1) {
    throw new Error("ttl must be a positive integer")
  }

  const messageID = options?.messageID ?? createMessageID()
  const kind: DeliverKind = options?.kind ?? "MESSAGE"
  const relayLayers = hops.length - 1
  if (relayLayers > 0 && ttl < relayLayers) {
    throw new Error(
      `ttl too low for selected route: ttl=${ttl}, required at least ${relayLayers}`
    )
  }

  const createdAt = Date.now()
  const signature = sign(
    sender.privateKey,
    createDeliverSignaturePayload({
      kind,
      messageID,
      createdAt,
      from: sender.publicKey,
      payload: message,
    })
  )

  // Innermost layer: a signed delivery instruction for the destination
  const dest = hops[hops.length - 1]
  const deliverLayer: DeliverInstruction = {
    type: "DELIVER",
    kind,
    messageID,
    createdAt,
    from: sender.publicKey,
    payload: message,
    signature,
  }
  let encrypted = sealedBox(dest.nodeID, JSON.stringify(deliverLayer))

  // Wrap outward from second-to-last hop back to the first hop
  for (let i = hops.length - 2; i >= 0; i--) {
    const relay: RelayInstruction = {
      type: "RELAY",
      next: hops[i + 1].onion,
      ttl: ttl - i,
      payload: encrypted,
    }
    encrypted = sealedBox(hops[i].nodeID, JSON.stringify(relay))
  }

  return encrypted
}

/**
 * Send a message to the final destination via a multi-hop path over Tor.
 * hops must include every intermediate relay AND the final destination.
 */
export async function sendMessage(
  hops: Hop[],
  message: string,
  sender: { publicKey: string; privateKey: string },
  options?: {
    ttl?: number
    messageID?: string
    kind?: DeliverKind
  }
): Promise<{ messageID: string }> {
  assertValidHops(hops)
  const messageID = options?.messageID ?? createMessageID()
  const torAgent = new SocksProxyAgent(`socks5h://127.0.0.1:${config.socksPort}`)
  const packet = buildOnion(hops, message, sender, {
    ttl: options?.ttl,
    messageID,
    kind: options?.kind,
  })
  await axios.post(
    `http://${hops[0].onion}/relay`,
    { data: packet },
    { httpAgent: torAgent }
  )
  console.log(
    `[SEND] message → ${hops[hops.length - 1].onion} via ${hops.length} hop(s)`
  )
  return { messageID }
}
