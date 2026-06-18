# Onion P2P Network

A decentralized, asynchronous Peer-to-Peer messaging network built entirely on top of Tor Onion Routing. 

Unlike traditional P2P networks that expose participant IP addresses, this project routes all node-to-node communication through Tor Hidden Services (`.onion` addresses), ensuring that nodes cannot easily trace the physical location or IP address of their peers. Furthermore, it implements "Russian Nesting Doll" layered encryption (Onion Routing) within the application layer itself to securely multi-hop messages across the network.

---

## Current Features

* **Tor Hidden Services**: Every node automatically hosts an Express HTTP server exposed as a `.onion` address, acting as a receiver for incoming packets.
* **Cryptographic Identity**: Nodes are identified by a generated Ed25519 public key (`nodeID`). All messages are cryptographically signed by the sender and verified by the receiver.
* **Application-Layer Onion Routing**: Messages are wrapped in multiple layers of Curve25519 encryption (`sealedBox`). Intermediate relays can only decrypt instructions for the *next hop*, blinding them to both the message content and the final destination.
* **Anti-Replay Protection**: Packets contain freshness timestamps (`createdAt`). The network enforces strict Time-To-Live (TTL) limits and clock skew rules to reject expired or replayed packets.
* **Reliable ACK System**: Upon successful delivery, the destination node fires an Acknowledgment (ACK) packet back through a new random circuit. Failed ACKs are picked up by a background SQLite worker and aggressively retried using an exponential backoff policy.
* **Signed Peer Announcements**: Nodes announce themselves to the network using timestamped, cryptographically signed payloads to prevent spoofing and Sybil-like identity hijacking.
* **Interactive CLI Controller**: A local terminal interface to easily manage the node, view the inbox, and send messages securely over the network.

---

## Architecture

The system is designed with a strict separation of concerns, heavily utilizing background workers to handle unreliability in Tor connections.

### Components
1. **The Daemon (`server.ts`)**: The core background process. It runs an Express HTTP server listening on the Tor proxy. It handles unwrapping encryption layers, routing, signature verification, and updating the local SQLite database.
2. **The Crypto Engine (`crypto.ts`)**: Wraps `libsodium-wrappers` to handle Ed25519 signing and Curve25519 anonymous encryption.
3. **The Router (`onion.ts`)**: Handles dynamic circuit building (`selectRoute`) and the construction of the multi-layered encrypted packets (`buildOnion`).
4. **The Peer Manager (`peer.ts`)**: Maintains an active dictionary mapping known `nodeID`s to their respective `.onion` addresses.
5. **The Controller (`cli.ts`)**: A lightweight Node.js script that communicates with the local daemon to provide a human-readable interface.

### The Message Flow
1. **Sending**: Node A wants to message Node Z. Node A selects random relays (Node B and Node C). Node A encrypts the message for Node Z, wraps that in instructions for Node C, and wraps *that* in instructions for Node B.
2. **Relaying**: Node A sends the package to Node B. Node B unlocks its layer, reads "Next hop: Node C", and forwards it. Node C does the same, forwarding to Node Z.
3. **Delivery & ACK**: Node Z unlocks the final layer, verifies Node A's signature, and saves the message to its local SQLite DB. Node Z then builds a brand new circuit and sends an `ACK` packet back to Node A.

---

## Setup & Run Instructions

### Prerequisites
You will need the following installed on your machine:
* [Node.js](https://nodejs.org/en/) (v18+ recommended)
* [Tor Daemon](https://www.torproject.org/download/) (Must be installed and running as a background service)
* `pnpm` (or `npm`)

### 1. Configure the Tor Daemon
The application expects Tor to run locally and expose a SOCKS5 proxy on port `9050`. It also needs Tor to read from our local `torrc` configuration to generate the Hidden Service.

Depending on your OS, launch Tor pointing to the local `torrc` file provided in the repository:
```bash
tor -f ./torrc
```
*(Wait until Tor prints `Bootstrapped 100% (done): Done` before proceeding).*

### 2. Install Dependencies
Open a new terminal window and navigate into the `server` directory:
```bash
cd server
pnpm install
```

### 3. Environment Variables
Copy the example environment file and configure it if necessary:
```bash
cp .env.example .env
```
*(By default, the `.env` settings are already configured for local testing).*

### 4. Start the Node Daemon
Start the main application. This will generate your cryptographic identity, connect to the Tor network, and spin up the background workers:
```bash
pnpm run dev
```
*Note: On first boot, check the `server/hidden_service` directory. Tor will automatically generate your `.onion` address and save it in `hidden_service/hostname`.*

### 5. Open the CLI
To actually send messages and interact with the node, open a third terminal window and run the CLI script:
```bash
cd server
npx tsx src/cli.ts
```

From the CLI menu, you can:
1. View your newly generated Public Key and Onion Address.
2. View known peers on the network.
3. Check your Inbox/Outbox for `PENDING`, `SENT`, and `DELIVERED` messages.
4. Send an encrypted message to another node by pasting their Public Key.

### Automated Local Cluster Testing
To easily test multi-hop routing locally without manually duplicating folders or managing `.env` files, this repository includes an orchestration script that simulates a full 4-node network on a single machine.

1. In the `server` directory, execute:
   ```bash
   npx tsx src/run-cluster.ts
   ```
2. The script will automatically generate an isolated `cluster_data/` sandbox containing unique `tor_data`, `app_data`, and hidden service directories for 4 individual nodes.
3. It spawns 4 background Tor daemons and 4 Node.js instances concurrently on separate ports.
4. It utilizes an **exponential backoff algorithm** to command the nodes to wait for Tor descriptors to publish and actively announce themselves to the bootstrap node.
5. Finally, it performs a **Peer Synchronization** sweep so all nodes instantly learn the full network topology.
6. Open a new terminal and run `HTTP_PORT=3002 npx tsx src/cli.ts` (or port 3003, 3004) to access any peripheral node and securely send messages through the local Tor circuits!
