import "dotenv/config"
import path from "path"

/**
 * All runtime configuration is read from environment variables.
 * This makes the same codebase deployable on any machine.
 *
 * Example – run as a specific node:
 *   HTTP_PORT=9001 SOCKS_PORT=11050 BOOTSTRAP_ONIONS=abc.onion pnpm dev
 */
export const config = {
  // Port this node's HTTP server listens on
  httpPort: parseInt(process.env.HTTP_PORT ?? "9000"),

  // SOCKS5 port of this node's local Tor daemon
  socksPort: parseInt(process.env.SOCKS_PORT ?? "9050"),

  // Directory for identity.json and peers.json
  dataDir: process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(process.cwd(), "node_data"),

  // Directory containing Tor's hostname file for this node's hidden service
  hiddenServiceDir: process.env.HIDDEN_SERVICE_DIR
    ? path.resolve(process.env.HIDDEN_SERVICE_DIR)
    : path.join(process.cwd(), "hidden_service"),

  // Comma-separated .onion addresses to bootstrap peer discovery from
  bootstrapOnions: (process.env.BOOTSTRAP_ONIONS ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean),

  // Default number of relay hops before final destination
  defaultRelayHops: parseInt(process.env.DEFAULT_RELAY_HOPS ?? "2"),

  // Packet-level TTL applied while building relay layers
  defaultPacketTtl: parseInt(process.env.DEFAULT_PACKET_TTL ?? "8"),

  // Signed packet freshness window for DELIVER/ACK processing
  maxPacketAgeMs: parseInt(process.env.MAX_PACKET_AGE_MS ?? "300000"),

  // Allowed clock skew for future-dated packets
  maxPacketFutureSkewMs: parseInt(process.env.MAX_PACKET_FUTURE_SKEW_MS ?? "15000"),

  // Freshness window for signed peer announcements
  maxPeerAnnouncementAgeMs: parseInt(process.env.MAX_PEER_ANNOUNCEMENT_AGE_MS ?? "300000"),

  // Require relay next-hop onions to exist in local trusted peers table
  enforceKnownRelayTargets: (process.env.ENFORCE_KNOWN_RELAY_TARGETS ?? "true") === "true",

  // ACK retry worker polling interval and backoff policy
  ackRetryPollMs: parseInt(process.env.ACK_RETRY_POLL_MS ?? "3000"),
  ackRetryMaxAttempts: parseInt(process.env.ACK_RETRY_MAX_ATTEMPTS ?? "6"),
  ackRetryBaseBackoffMs: parseInt(process.env.ACK_RETRY_BASE_BACKOFF_MS ?? "2000"),
  ackRetryMaxBackoffMs: parseInt(process.env.ACK_RETRY_MAX_BACKOFF_MS ?? "60000"),
}
