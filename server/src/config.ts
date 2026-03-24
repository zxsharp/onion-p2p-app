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
}
