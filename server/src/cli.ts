import "dotenv/config"
import readline from "readline"

const HTTP_PORT = process.env.HTTP_PORT || 3000
const LOCAL_DAEMON = `http://127.0.0.1:${HTTP_PORT}`

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

async function showMenu() {
  console.log("\n=== Onion P2P CLI ===")
  console.log("1. View My Identity")
  console.log("2. List Network Peers")
  console.log("3. Read Inbox")
  console.log("4. Send Message")
  console.log("5. Join Network (Bootstrap)")
  console.log("6. Exit")
  
  rl.question("Select an option: ", async (answer) => {
    try {
      if (answer === '1') await fetchIdentity()
      else if (answer === '2') await fetchPeers()
      else if (answer === '3') await fetchMessages()
      else if (answer === '4') await triggerSendMessage()
      else if (answer === '5') await triggerJoinNetwork()
      else if (answer === '6') process.exit(0)
    } catch (err) {
      const e = err as Error
      console.error("Error communicating with daemon:", e.message)
    }
    
    if (answer !== '4' && answer !== '5') {
      setTimeout(showMenu, 500)
    }
  })
}

async function fetchIdentity() {
  const res = await fetch(`${LOCAL_DAEMON}/identity`).then(r => r.json())
  console.log(`\n My Node ID: ${res.nodeID}`)
  console.log(` My Onion:   ${res.onion}`)
}

async function fetchPeers() {
  const res = await fetch(`${LOCAL_DAEMON}/peers`).then(r => r.json())
  console.log("\n Known Peers:")
  if (!res.peers || res.peers.length === 0) {
    console.log("   (No peers found)")
    return
  }
  res.peers.forEach((p: any, i: number) => {
    console.log(`[${i}] ${p.nodeID.substring(0, 8)}... -> ${p.onion}`)
  })
}

async function fetchMessages() {
  const res = await fetch(`${LOCAL_DAEMON}/messages`).then(r => r.json())
  console.log("\n Inbox & Outbox:")
  if (!res.messages || res.messages.length === 0) {
    console.log("   (No messages found)")
    return
  }
  res.messages.forEach((m: any) => {
    const dir = m.direction === 'INBOUND' ? '↓' : '↑'
    const status = m.status.padEnd(9)
    console.log(` ${dir} [${status}] Node: ${m.peerNodeID?.substring(0,8)}... | Msg: ${m.payload}`)
  })
}

async function triggerSendMessage() {
  rl.question("\nEnter Destination NodeID: ", (destinationNodeID) => {
    if (!destinationNodeID) {
      console.log("Cancelled.")
      showMenu()
      return
    }
    rl.question("Enter Message: ", async (message) => {
      if (!message) {
        console.log("Cancelled.")
        showMenu()
        return
      }
      try {
        const req = await fetch(`${LOCAL_DAEMON}/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ destinationNodeID, message })
        })
        const res = await req.json()
        
        if (res.ok) {
          console.log(`\n Message dispatched!`)
          console.log(`   Message ID: ${res.messageID}`)
          console.log(`   Relay Hops: ${res.relayCount}`)
        } else {
          console.log(`\n Failed: ${res.error}`)
        }
      } catch (err) {
        const e = err as Error
        console.log(`\n Network Error: ${e.message}`)
      }
      
      setTimeout(showMenu, 500)
    })
  })
}

async function triggerJoinNetwork() {
  rl.question("\nEnter Bootstrap Onion Address: ", async (bootstrapOnion) => {
    if (!bootstrapOnion) {
      console.log("Cancelled.")
      showMenu()
      return
    }
    try {
      const req = await fetch(`${LOCAL_DAEMON}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bootstrapOnion })
      })
      const res = await req.json()
      
      if (res.ok) {
        console.log(`\n Successfully joined the network!`)
        console.log(`   Discovered ${res.peers?.length || 0} peers.`)
      } else {
        console.log(`\n Failed: ${res.error}`)
      }
    } catch (err) {
      const e = err as Error
      console.log(`\n Network Error: ${e.message}`)
    }
    setTimeout(showMenu, 500)
  })
}

console.log(`Connecting to local daemon on ${LOCAL_DAEMON}...`)
showMenu()
