import fs from "fs"
import path from "path"
import sodium from "libsodium-wrappers"
import { config } from "./config"

let initialized = false

export async function initCrypto() {
  if (!initialized) {
    await sodium.ready
    initialized = true
  }
}

/** Generate an ephemeral keypair without touching disk. Useful for tests. */
export function generateKeypair() {
  const keypair = sodium.crypto_sign_keypair()
  return {
    publicKey: Buffer.from(keypair.publicKey).toString("hex"),
    privateKey: Buffer.from(keypair.privateKey).toString("hex"),
  }
}

export function getIdentity() {

  const dir = config.dataDir
  const file = path.join(dir, "identity.json")

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir)
  }

  if (fs.existsSync(file)) {
    const data = JSON.parse(fs.readFileSync(file, "utf8"))
    return data
  }

  const keypair = sodium.crypto_sign_keypair()

  const identity = {
    publicKey: Buffer.from(keypair.publicKey).toString("hex"),
    privateKey: Buffer.from(keypair.privateKey).toString("hex")
  }

  fs.writeFileSync(file, JSON.stringify(identity, null, 2))

  return identity
}

export function sign(privateKeyHex: string, message: string) {

  const privateKey = Buffer.from(privateKeyHex, "hex")
  const msg = Buffer.from(message)

  const signature = sodium.crypto_sign_detached(msg, privateKey)

  return Buffer.from(signature).toString("hex")
}

export function verify(publicKeyHex: string, message: string, signatureHex: string) {

  const publicKey = Buffer.from(publicKeyHex, "hex")
  const msg = Buffer.from(message)
  const sig = Buffer.from(signatureHex, "hex")

  return sodium.crypto_sign_verify_detached(sig, msg, publicKey)

}

// Anonymously encrypt a message for a recipient (Ed25519 pub key → Curve25519 for crypto_box_seal)
export function sealedBox(recipientPublicKeyHex: string, message: string): string {
  const recipientCurve = sodium.crypto_sign_ed25519_pk_to_curve25519(
    Buffer.from(recipientPublicKeyHex, "hex")
  )
  const ciphertext = sodium.crypto_box_seal(Buffer.from(message), recipientCurve)
  return Buffer.from(ciphertext).toString("base64")
}

// Decrypt a sealed box using own Ed25519 keypair (converted to Curve25519)
export function openSealedBox(
  myPublicKeyHex: string,
  myPrivateKeyHex: string,
  ciphertextBase64: string
): string {
  const myCurvePub = sodium.crypto_sign_ed25519_pk_to_curve25519(
    Buffer.from(myPublicKeyHex, "hex")
  )
  const myCurveSec = sodium.crypto_sign_ed25519_sk_to_curve25519(
    Buffer.from(myPrivateKeyHex, "hex")
  )
  const ciphertext = Buffer.from(ciphertextBase64, "base64")
  const plaintext = sodium.crypto_box_seal_open(ciphertext, myCurvePub, myCurveSec)
  return Buffer.from(plaintext).toString("utf8")
}