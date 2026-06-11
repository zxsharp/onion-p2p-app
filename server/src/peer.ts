import fs from "fs"
import path from "path"
import { config } from "./config"

const FILE = path.join(config.dataDir, "peers.json")

export interface Peer {
  nodeID: string
  onion: string
}

export class PeerManager {

  peers: Map<string, Peer> = new Map()

  addPeer(nodeID: string, onion: string) {
    const existing = this.peers.get(nodeID)
    if (!existing || existing.onion !== onion) {
      this.peers.set(nodeID, { nodeID, onion })
      this.savePeers()
    }
  }

  getPeer(nodeID: string) {
    return this.peers.get(nodeID)
  }

  getAllPeers() {
    return Array.from(this.peers.values())
  }

  hasOnion(onion: string) {
    for (const peer of this.peers.values()) {
      if (peer.onion === onion) return true
    }
    return false
  }

  
  loadPeers() {
    if (!fs.existsSync(FILE)) return

    const data = JSON.parse(fs.readFileSync(FILE,"utf8"))

    data.forEach((p:any)=>{
        this.peers.set(p.nodeID,p)
    })
  }

  savePeers(){
    const list = Array.from(this.peers.values())
    fs.writeFileSync(FILE, JSON.stringify(list,null,2))
  }

}