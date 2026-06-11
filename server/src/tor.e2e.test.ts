import axios from "axios"
import fs from "fs"
import os from "os"
import path from "path"
import { spawn, spawnSync, type ChildProcess } from "child_process"
import { SocksProxyAgent } from "socks-proxy-agent"
import { sign } from "./crypto"

type TestNode = {
  name: string
  httpPort: number
  socksPort: number
  controlPort: number
  rootDir: string
  dataDir: string
  hiddenServiceDir: string
  torrcPath: string
  torLogPath: string
  onion?: string
  nodeID?: string
  privateKey?: string
  torProc?: ChildProcess
  serverProc?: ChildProcess
}

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

function hasTorBinary(): boolean {
  const probe = spawnSync("tor", ["--version"], { stdio: "ignore" })
  return probe.status === 0
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor<T>(
  label: string,
  producer: () => T | null | undefined | Promise<T | null | undefined>,
  timeoutMs: number,
  intervalMs = 500
): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await producer()
      if (value !== null && value !== undefined) {
        return value
      }
    } catch {
      // Ignore transient probe failures and keep polling until timeout.
    }
    await sleep(intervalMs)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function makeTorrc(node: TestNode): string {
  return [
    `SocksPort ${node.socksPort}`,
    `ControlPort ${node.controlPort}`,
    "CookieAuthentication 1",
    "",
    `DataDirectory ${node.dataDir}`,
    "",
    `HiddenServiceDir ${node.hiddenServiceDir}`,
    "HiddenServiceVersion 3",
    `HiddenServicePort 80 127.0.0.1:${node.httpPort}`,
    "",
    "Log notice stdout",
    `Log notice file ${node.torLogPath}`,
  ].join("\n")
}

async function startTor(node: TestNode) {
  fs.mkdirSync(node.dataDir, { recursive: true, mode: 0o700 })
  fs.mkdirSync(node.hiddenServiceDir, { recursive: true, mode: 0o700 })
  fs.chmodSync(node.dataDir, 0o700)
  fs.chmodSync(node.hiddenServiceDir, 0o700)
  fs.writeFileSync(node.torrcPath, makeTorrc(node))

  const proc = spawn("tor", ["-f", node.torrcPath], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  node.torProc = proc

  proc.stdout?.on("data", chunk => {
    const line = String(chunk).trim()
    if (line) console.log(`[tor:${node.name}] ${line}`)
  })
  proc.stderr?.on("data", chunk => {
    const line = String(chunk).trim()
    if (line) console.error(`[tor:${node.name}:err] ${line}`)
  })

  const hostnameFile = path.join(node.hiddenServiceDir, "hostname")
  node.onion = await waitFor(
    `${node.name} onion hostname`,
    () => {
      if (!fs.existsSync(hostnameFile)) return null
      const value = fs.readFileSync(hostnameFile, "utf8").trim()
      return value.length > 0 ? value : null
    },
    120000,
    700
  )

  await waitFor(
    `${node.name} tor bootstrap 100%`,
    () => {
      if (!fs.existsSync(node.torLogPath)) return null
      const content = fs.readFileSync(node.torLogPath, "utf8")
      return content.includes("Bootstrapped 100%") ? true : null
    },
    240000,
    1000
  )
}

async function startServer(node: TestNode, serverDir: string) {
  const env = {
    ...process.env,
    HTTP_PORT: String(node.httpPort),
    SOCKS_PORT: String(node.socksPort),
    DATA_DIR: path.join(node.rootDir, "node_data"),
    HIDDEN_SERVICE_DIR: node.hiddenServiceDir,
    BOOTSTRAP_ONIONS: "",
    DEFAULT_RELAY_HOPS: "2",
    DEFAULT_PACKET_TTL: "8",
  }

  fs.mkdirSync(env.DATA_DIR, { recursive: true })

  const proc = spawn("pnpm", ["tsx", "src/server.ts"], {
    cwd: serverDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  node.serverProc = proc

  proc.stdout?.on("data", chunk => {
    const line = String(chunk).trim()
    if (line) console.log(`[srv:${node.name}] ${line}`)
  })
  proc.stderr?.on("data", chunk => {
    const line = String(chunk).trim()
    if (line) console.error(`[srv:${node.name}:err] ${line}`)
  })

  await waitFor(
    `${node.name} server readiness`,
    () => {
      if (proc.exitCode !== null) {
        throw new Error(`${node.name} server exited early with ${proc.exitCode}`)
      }
      try {
        // /peers exists once app is listening.
        return axios.get(`http://127.0.0.1:${node.httpPort}/peers`, { timeout: 1000 })
      } catch {
        return null
      }
    },
    30000,
    500
  )

  const identityFile = path.join(env.DATA_DIR, "identity.json")
  const identity = await waitFor(
    `${node.name} identity`,
    () => {
      if (!fs.existsSync(identityFile)) return null
      return JSON.parse(fs.readFileSync(identityFile, "utf8")) as {
        publicKey: string
        privateKey: string
      }
    },
    30000,
    500
  )

  node.nodeID = identity.publicKey
  node.privateKey = identity.privateKey
}

async function announcePeer(from: TestNode, to: TestNode, onionToAnnounce?: string) {
  const agent = new SocksProxyAgent(`socks5h://127.0.0.1:${from.socksPort}`)
  const createdAt = Date.now()
  const onion = onionToAnnounce ?? from.onion
  const payload = JSON.stringify({
    nodeID: from.nodeID,
    onion,
    createdAt,
  })
  const signature = sign(from.privateKey ?? "", payload)
  let lastError: unknown = null
  for (let attempt = 1; attempt <= 12; attempt++) {
    try {
      await axios.post(
        `http://${to.onion}/peer-request`,
        {
          nodeID: from.nodeID,
          onion,
          createdAt,
          signature,
        },
        {
          timeout: 15000,
          httpAgent: agent,
        }
      )
      return
    } catch (err) {
      lastError = err
      await sleep(1500)
    }
  }

  throw lastError
}

async function waitForDelivered(sender: TestNode, messageID: string) {
  try {
    await waitFor(
      `sender ${sender.name} delivery status`,
      async () => {
        const res = await axios.get(`http://127.0.0.1:${sender.httpPort}/messages`, {
          params: { limit: 300 },
          timeout: 1500,
        })
        const row = res.data.messages.find(
          (m: any) => m.messageID === messageID && m.direction === "OUTBOUND"
        )
        return row?.status === "DELIVERED" ? row : null
      },
      120000,
      1000
    )
  } catch {
    const res = await axios.get(`http://127.0.0.1:${sender.httpPort}/messages`, {
      params: { limit: 300 },
      timeout: 4000,
    })
    const outbound = res.data.messages.find(
      (m: any) => m.messageID === messageID && m.direction === "OUTBOUND"
    )
    const inboundAck = res.data.messages.find(
      (m: any) => m.direction === "INBOUND" && m.kind === "ACK" && m.payload === messageID
    )
    throw new Error(
      `Timed out waiting for delivery: outboundStatus=${outbound?.status ?? "missing"}, ` +
      `inboundAckSeen=${Boolean(inboundAck)}`
    )
  }
}

async function waitForInboundMessage(destination: TestNode, messageID: string, payload: string) {
  await waitFor(
    `destination ${destination.name} inbound message`,
    async () => {
      const res = await axios.get(`http://127.0.0.1:${destination.httpPort}/messages`, {
        params: { limit: 200 },
        timeout: 1500,
      })
      const row = res.data.messages.find(
        (m: any) =>
          m.messageID === messageID &&
          m.direction === "INBOUND" &&
          m.kind === "MESSAGE" &&
          m.payload === payload
      )
      return row ?? null
    },
    45000,
    700
  )
}

async function stopProcess(proc: ChildProcess | undefined, label: string) {
  if (!proc || proc.exitCode !== null) return
  proc.kill("SIGTERM")

  const done = await Promise.race([
    new Promise<boolean>(resolve => {
      proc.once("exit", () => resolve(true))
    }),
    new Promise<boolean>(resolve => {
      setTimeout(() => resolve(false), 5000)
    }),
  ])

  if (!done && proc.exitCode === null) {
    console.warn(`[cleanup] force killing ${label}`)
    proc.kill("SIGKILL")
  }
}

function randomDistinctPair<T>(items: T[]): [T, T] {
  const firstIdx = Math.floor(Math.random() * items.length)
  let secondIdx = Math.floor(Math.random() * items.length)
  while (secondIdx === firstIdx) {
    secondIdx = Math.floor(Math.random() * items.length)
  }
  return [items[firstIdx], items[secondIdx]]
}

async function run() {
  console.log("\n== Tor E2E test: real daemons + real servers ==")

  if (!hasTorBinary()) {
    console.error("Tor binary not found. Install tor to run test:tor.")
    process.exit(1)
  }

  const serverDir = path.resolve(process.cwd())
  const workspaceRoot = path.resolve(serverDir, "..")
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "onion-p2p-tor-e2e-"))
  console.log(`Using temp test root: ${testRoot}`)

  const nodes: TestNode[] = Array.from({ length: 4 }, (_, i) => {
    const idx = i + 1
    const rootDir = path.join(testRoot, `node${idx}`)
    return {
      name: `n${idx}`,
      httpPort: 29000 + idx,
      socksPort: 19050 + idx,
      controlPort: 19150 + idx,
      rootDir,
      dataDir: path.join(rootDir, "tor_data"),
      hiddenServiceDir: path.join(rootDir, "hidden_service"),
      torrcPath: path.join(rootDir, "torrc"),
      torLogPath: path.join(rootDir, "tor.log"),
    }
  })

  try {
    fs.mkdirSync(testRoot, { recursive: true })
    console.log("\n-- Starting Tor daemons --")
    for (const node of nodes) {
      fs.mkdirSync(node.rootDir, { recursive: true })
      await startTor(node)
      assert(Boolean(node.onion), `${node.name} published onion hostname`)
    }

    console.log("\n-- Starting server instances --")
    for (const node of nodes) {
      await startServer(node, serverDir)
      assert(Boolean(node.nodeID), `${node.name} generated identity and started server`)
    }

    console.log("\n-- Peer discovery over Tor onion --")
    for (const from of nodes) {
      for (const to of nodes) {
        if (from.name === to.name) continue
        await announcePeer(from, to)
      }
    }
    assert(true, "all nodes announced to all peers through Tor")

    console.log("\n-- Random routed message exchange + ACK --")
    const [sender, destination] = randomDistinctPair(nodes)
    const payload = `tor-e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`

    const sendRes = await axios.post(
      `http://127.0.0.1:${sender.httpPort}/send`,
      {
        destinationNodeID: destination.nodeID,
        message: payload,
        relayHops: 2,
        ttl: 4,
      },
      { timeout: 20000 }
    )

    assert(sendRes.data.ok === true, "sender /send accepted routed message")
    assert(sendRes.data.relayCount === 2, "route used requested relay count")

    await waitForInboundMessage(destination, sendRes.data.messageID, payload)
    assert(true, "destination received inbound message")

    await waitForDelivered(sender, sendRes.data.messageID)
    assert(true, "sender outbound status reached DELIVERED via ACK")

    console.log("\n-- TTL rejection over HTTP API --")
    let ttlRejected = false
    try {
      await axios.post(
        `http://127.0.0.1:${sender.httpPort}/send`,
        {
          destinationNodeID: destination.nodeID,
          message: "ttl-too-low",
          relayHops: 2,
          ttl: 1,
        },
        { timeout: 10000 }
      )
    } catch (err: any) {
      ttlRejected = err.response?.status === 400
    }
    assert(ttlRejected, "send API rejects ttl lower than route depth")

    console.log("\n-- Peer update behavior --")
    const target = nodes[0]
    const changer = nodes[1]
    const validButFakeOnion = "aaaaaaaaaaaaaaaa.onion"
    await announcePeer(changer, target, validButFakeOnion)
    const peersRes = await axios.get(`http://127.0.0.1:${target.httpPort}/peers`, {
      timeout: 10000,
    })
    const changed = peersRes.data.peers.find((p: any) => p.nodeID === changer.nodeID)
    assert(
      changed?.onion === validButFakeOnion,
      "peer table updates onion when same node id is re-announced"
    )

    console.log("\n-- Local storage artifacts --")
    const hasDb = nodes.every(node =>
      fs.existsSync(path.join(node.rootDir, "node_data", "messages.db"))
    )
    assert(hasDb, "each node created local SQLite storage")
  } finally {
    console.log("\n-- Cleanup --")
    for (const node of nodes) {
      await stopProcess(node.serverProc, `server ${node.name}`)
    }
    for (const node of nodes) {
      await stopProcess(node.torProc, `tor ${node.name}`)
    }
  }

  console.log("\n== Result summary ==")
  console.log(`passed=${passed} failed=${failed}`)

  if (failed > 0) {
    process.exit(1)
  }

  console.log(`\nTor E2E test completed successfully in ${workspaceRoot}`)
}

run().catch(err => {
  console.error("Unexpected Tor E2E test failure:", err)
  process.exit(1)
})
