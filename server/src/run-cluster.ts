import fs from "fs"
import path from "path"
import { spawn, ChildProcess } from "child_process"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, "..")
const CLUSTER_DIR = path.join(PROJECT_ROOT, "cluster_data")

const NUM_NODES = 4
const BASE_HTTP_PORT = 3000
const BASE_SOCKS_PORT = 9050

interface NodeConfig {
  id: number
  httpPort: number
  socksPort: number
  dir: string
  torrcPath: string
  hiddenServiceDir: string
  appDataDir: string
  onion?: string
  torProc?: ChildProcess
  appProc?: ChildProcess
}

async function startTor(node: NodeConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`[Node ${node.id}] Starting Tor on SOCKS port ${node.socksPort}...`)
    
    node.torProc = spawn("tor", ["-f", node.torrcPath], { stdio: ["ignore", "pipe", "pipe"] })
    
    let bootstrapped = false

    node.torProc.stdout?.on("data", (data) => {
      const output = data.toString()
      if (output.includes("Bootstrapped 100%")) {
        bootstrapped = true
        console.log(`[Node ${node.id}] Tor Bootstrapped 100%!`)
        
        // Read the generated onion address
        setTimeout(() => {
          try {
            const hostname = fs.readFileSync(path.join(node.hiddenServiceDir, "hostname"), "utf8").trim()
            node.onion = hostname
            console.log(`[Node ${node.id}] Onion Address: ${hostname}`)
            resolve()
          } catch (err) {
            reject(new Error(`Node ${node.id} failed to read hostname: ` + err))
          }
        }, 1000)
      }
    })

    node.torProc.stderr?.on("data", (data) => {
      // Tor logs warnings to stderr, usually harmless but good to monitor
    })

    node.torProc.on("close", (code) => {
      if (!bootstrapped) {
        reject(new Error(`Tor for Node ${node.id} exited prematurely with code ${code}`))
      }
    })
  })
}

async function main() {
  console.log(" Initializing Local Tor Cluster...\n")

  // Cleanup old cluster data
  if (fs.existsSync(CLUSTER_DIR)) {
    fs.rmSync(CLUSTER_DIR, { recursive: true, force: true })
  }
  fs.mkdirSync(CLUSTER_DIR, { recursive: true })

  const nodes: NodeConfig[] = []

  // 1. Setup Directories & Torrc files
  for (let i = 1; i <= NUM_NODES; i++) {
    const nodeDir = path.join(CLUSTER_DIR, `node${i}`)
    const hiddenServiceDir = path.join(nodeDir, "hidden_service")
    const torDataDir = path.join(nodeDir, "tor_data")
    const appDataDir = path.join(nodeDir, "app_data")
    const torrcPath = path.join(nodeDir, "torrc")

    fs.mkdirSync(hiddenServiceDir, { recursive: true, mode: 0o700 })
    fs.mkdirSync(torDataDir, { recursive: true, mode: 0o700 })
    fs.mkdirSync(appDataDir, { recursive: true })

    const httpPort = BASE_HTTP_PORT + i
    const socksPort = BASE_SOCKS_PORT + i

    // Generate isolated torrc
    const torrcContent = `
SocksPort ${socksPort}
DataDirectory ${torDataDir}
HiddenServiceDir ${hiddenServiceDir}
HiddenServicePort 80 127.0.0.1:${httpPort}
Log notice stdout
`
    fs.writeFileSync(torrcPath, torrcContent.trim())

    nodes.push({ id: i, httpPort, socksPort, dir: nodeDir, torrcPath, hiddenServiceDir, appDataDir })
  }

  // 2. Start Tor Daemons
  try {
    await Promise.all(nodes.map(startTor))
  } catch (err) {
    console.error("\n Failed to bootstrap Tor daemons:", err)
    cleanup(nodes)
    process.exit(1)
  }

  console.log("\n All Tor daemons online. Starting Node.js instances...\n")

  // 3. Start Node.js apps
  const bootstrapOnion = nodes[0].onion // Node 1 is the bootstrap node

  for (const node of nodes) {
    const env = {
      ...process.env,
      HTTP_PORT: node.httpPort.toString(),
      SOCKS_PORT: node.socksPort.toString(),
      DATA_DIR: node.appDataDir,
      HIDDEN_SERVICE_DIR: node.hiddenServiceDir,
      BOOTSTRAP_ONIONS: node.id === 1 ? "" : bootstrapOnion // Node 1 bootstraps nothing, others bootstrap to Node 1
    }

    console.log(`[Node ${node.id}] Starting Node.js app on port ${node.httpPort}...`)
    
    // Spawn server.ts via tsx
    node.appProc = spawn("npx", ["tsx", "src/server.ts"], {
      cwd: PROJECT_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    })

    node.appProc.stdout?.on("data", (data) => {
      const line = data.toString().trim()
      if (line.includes("Node listening") || line.includes("Peers after bootstrap")) {
        console.log(`[Node ${node.id}] ${line}`)
      }
    })
  }

  console.log("\n=======================================================")
  console.log("CLUSTER IS LIVE! Waiting for Tor Descriptors to publish...")
  console.log("=======================================================\n")
  
  nodes.forEach(node => {
    console.log(`> Node ${node.id} CLI:  HTTP_PORT=${node.httpPort} npx tsx src/cli.ts`)
  })

  // 4. Actively Command Nodes to Announce Themselves (Exponential Backoff)
  console.log("\nBeginning peer announcement (Tor takes 30-90s to route newly published descriptors)...")
  
  const targetOnion = nodes[0].onion // Everyone joins Node 1
  const MAX_RETRIES = 12
  const INITIAL_BACKOFF_MS = 5000
  const MAX_BACKOFF_MS = 20000

  const announcementPromises = []

  for (let i = 1; i < nodes.length; i++) {
    const node = nodes[i]
    
    // Fire and forget an async IIFE for each node
    const p = (async () => {
      let backoff = INITIAL_BACKOFF_MS
      
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const res = await fetch(`http://127.0.0.1:${node.httpPort}/join`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bootstrapOnion: targetOnion })
          })
          
          const data = await res.json()
          if (data.ok) {
            console.log(`[Node ${node.id}] successfully announced itself to Node 1 via Tor! (Attempt ${attempt})`)
            return true // Success, exit the retry loop
          }
        } catch (err) {
          // HTTP server might not be up yet, or Tor actively rejected the connection
        }
        
        if (attempt === MAX_RETRIES) {
          console.log(`[Node ${node.id}] failed to announce itself after ${MAX_RETRIES} attempts. Tor descriptor may be stuck.`)
          return false
        }
        
        // Sleep for 'backoff' milliseconds
        await new Promise(r => setTimeout(r, backoff))
        
        // Exponentially increase the backoff, capped at max
        backoff = Math.min(backoff * 1.5, MAX_BACKOFF_MS)
      }
      return false
    })()
    announcementPromises.push(p)
  }

  // 5. Final Peer Synchronization
  Promise.all(announcementPromises).then(async (results) => {
    // If all nodes successfully joined, Node 1 now knows everyone.
    // However, nodes 2, 3, and 4 only know Node 1. We must force them to fetch the full list again!
    if (results.every(r => r === true)) {
      console.log("\nPerforming final peer synchronization (pulling full directory from Node 1)...")
      for (let i = 1; i < nodes.length; i++) {
        const node = nodes[i]
        try {
          await fetch(`http://127.0.0.1:${node.httpPort}/join`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bootstrapOnion: targetOnion })
          })
          console.log(`[Node ${node.id}] successfully synced full peer list!`)
        } catch (e) {
          console.log(`[Node ${node.id}] failed to sync final peer list.`)
        }
      }
      console.log("\nCLUSTER BOOTSTRAP COMPLETE! You can now send messages between any nodes.")
    }
  })

  console.log("\nPress Ctrl+C to stop all daemons and exit.\n")

  // Handle shutdown gracefully
  process.on("SIGINT", () => {
    console.log("\nShutting down cluster...")
    cleanup(nodes)
    process.exit(0)
  })
}

function cleanup(nodes: NodeConfig[]) {
  for (const node of nodes) {
    if (node.appProc) node.appProc.kill()
    if (node.torProc) node.torProc.kill()
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
