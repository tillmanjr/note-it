import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import type { NativeKeys, Passkeys } from '@tdjr/core'

// A software authenticator for tests: real ES256 passkeys, "none" attestation, user verification reported.
// It answers like Windows Hello would, so the server's verification runs for real.

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest()
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')

const FLAG_UP = 0x01
const FLAG_UV = 0x04
/** Backup eligible and backed up: what a synced passkey reports. */
const FLAG_SYNCED = 0x08 | 0x10
const FLAG_AT = 0x40

export function softPasskeys({ synced = false } = {}): Passkeys & { keys: Map<string, KeyObject> } {
  const keys = new Map<string, KeyObject>()
  const counters = new Map<string, number>()

  const clientData = (type: string, challenge: string, origin: string) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }))

  const counter = (n: number) => {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n)
    return b
  }

  return {
    keys,
    async create(options, origin) {
      const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
      const credentialId = randomBytes(16)
      const jwk = publicKey.export({ format: 'jwk' })
      const cose = isoCBOR.encode(
        new Map<number, number | Uint8Array>([
          [1, 2], // kty: EC2
          [3, -7], // alg: ES256
          [-1, 1], // crv: P-256
          [-2, Buffer.from(jwk.x!, 'base64url')],
          [-3, Buffer.from(jwk.y!, 'base64url')],
        ]),
      )
      const idLength = Buffer.alloc(2)
      idLength.writeUInt16BE(credentialId.length)
      const authData = Buffer.concat([
        sha256(options.rpId),
        Buffer.from([FLAG_UP | FLAG_UV | FLAG_AT | (synced ? FLAG_SYNCED : 0)]),
        counter(0),
        Buffer.alloc(16), // aaguid
        idLength,
        credentialId,
        Buffer.from(cose),
      ])
      const attestation = isoCBOR.encode(
        new Map<string, unknown>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', authData],
        ]) as never,
      )
      keys.set(b64(credentialId), privateKey)
      counters.set(b64(credentialId), 0)
      return {
        credentialId: b64(credentialId),
        clientDataJSON: b64(clientData('webauthn.create', options.challenge, origin)),
        attestationObject: b64(attestation),
        transports: ['internal'],
      }
    },
    async get(options, origin) {
      const credentialId = options.allowCredentials.find((id) => keys.has(id))
      if (!credentialId) throw new Error('No passkey for this server on this device.')
      const count = (counters.get(credentialId) ?? 0) + 1
      counters.set(credentialId, count)
      const authData = Buffer.concat([sha256(options.rpId), Buffer.from([FLAG_UP | FLAG_UV | (synced ? FLAG_SYNCED : 0)]), counter(count)])
      const data = clientData('webauthn.get', options.challenge, origin)
      const signature = createSign('sha256').update(Buffer.concat([authData, sha256(data)])).sign(keys.get(credentialId)!)
      return {
        credentialId,
        clientDataJSON: b64(data),
        authenticatorData: b64(authData),
        signature: b64(signature),
      }
    },
  }
}

/** A software stand-in for the Android Keystore behind nativeKeyPasskeys: P-256 keys, DER signatures. */
export function softNativeKeys(): NativeKeys & { signed: number } {
  const keys = new Map<string, CryptoKey>()
  const state = {
    signed: 0,
    async createKey(alias: string) {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
      keys.set(alias, pair.privateKey)
      const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
      return { x: jwk.x!, y: jwk.y! }
    },
    async sign(alias: string, data: string) {
      const key = keys.get(alias)
      if (!key) throw new Error('No such key')
      const raw = new Uint8Array(
        await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(data, 'base64url')),
      )
      state.signed++
      return Buffer.from(derSignature(raw)).toString('base64url')
    },
  }
  return state
}

/** WebCrypto's r‖s ECDSA signature as DER, which Android Keystore (and WebAuthn) use. */
function derSignature(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0
    while (i < b.length - 1 && b[i] === 0) i++
    const v = b.subarray(i)
    return v[0] & 0x80 ? Uint8Array.of(0x02, v.length + 1, 0, ...v) : Uint8Array.of(0x02, v.length, ...v)
  }
  const r = int(raw.subarray(0, 32))
  const s = int(raw.subarray(32))
  return Uint8Array.of(0x30, r.length + s.length, ...r, ...s)
}
