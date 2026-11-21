import type { Passkeys } from './syncClient'
import type { PasskeyAssertion, PasskeyCreated } from './syncProtocol'

// A device key held by the OS (Android Keystore; later the iPhone Secure Enclave), presented to the server as a
// WebAuthn passkey (docs/mobile.md). The native side only creates P-256 keys and signs after the user verifies;
// the WebAuthn framing is built here, so the server's passkey flow and checks apply unchanged. The key can't be
// exported or backed up, so registrations carry no backup flags and pass the server's device-bound check.

export interface NativeKeys {
  /** Creates a P-256 key under `alias` that signs only after biometric or screen-lock verification. */
  createKey(alias: string): Promise<{ x: string; y: string }>
  /** Verifies the user, then signs `data` with ECDSA/SHA-256. Returns a DER signature. All values base64url. */
  sign(alias: string, data: string, reason: string): Promise<string>
}

const FLAG_UP = 0x01
const FLAG_UV = 0x04
const FLAG_AT = 0x40

export const toB64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
export const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let i = 0
  for (const p of parts) {
    out.set(p, i)
    i += p.length
  }
  return out
}
const sha256 = async (data: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>))
const utf8 = (s: string) => new TextEncoder().encode(s)

// ---------- Minimal CBOR (only what attestation objects and COSE keys need) ----------

type Cbor = number | string | Uint8Array | Map<number | string, Cbor>

function head(major: number, n: number): Uint8Array {
  if (n < 24) return Uint8Array.of((major << 5) | n)
  if (n < 0x100) return Uint8Array.of((major << 5) | 24, n)
  if (n < 0x10000) return Uint8Array.of((major << 5) | 25, n >> 8, n & 0xff)
  return Uint8Array.of((major << 5) | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff)
}

export function cbor(value: Cbor): Uint8Array {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value)
  if (typeof value === 'string') {
    const bytes = utf8(value)
    return concat(head(3, bytes.length), bytes)
  }
  if (value instanceof Uint8Array) return concat(head(2, value.length), value)
  const parts: Uint8Array[] = [head(5, value.size)]
  for (const [k, v] of value) parts.push(cbor(k), cbor(v))
  return concat(...parts)
}

const clientData = (type: string, challenge: string, origin: string) =>
  utf8(JSON.stringify({ type, challenge, origin, crossOrigin: false }))

/** Passkeys backed by native device keys. Each key's alias is its credential id. */
export function nativeKeyPasskeys(keys: NativeKeys): Passkeys {
  return {
    async create(options, origin): Promise<PasskeyCreated> {
      const credentialId = crypto.getRandomValues(new Uint8Array(16))
      const alias = toB64url(credentialId)
      const { x, y } = await keys.createKey(alias)
      const cose = cbor(
        new Map<number, Cbor>([
          [1, 2], // kty: EC2
          [3, -7], // alg: ES256
          [-1, 1], // crv: P-256
          [-2, fromB64url(x)],
          [-3, fromB64url(y)],
        ]),
      )
      const authData = concat(
        await sha256(utf8(options.rpId)),
        Uint8Array.of(FLAG_UP | FLAG_UV | FLAG_AT),
        new Uint8Array(4), // sign count: not kept (0)
        new Uint8Array(16), // aaguid
        Uint8Array.of(credentialId.length >> 8, credentialId.length & 0xff),
        credentialId,
        cose,
      )
      const attestationObject = cbor(
        new Map<string, Cbor>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', authData],
        ]),
      )
      return {
        credentialId: alias,
        clientDataJSON: toB64url(clientData('webauthn.create', options.challenge, origin)),
        attestationObject: toB64url(attestationObject),
        transports: ['internal'],
      }
    },

    async get(options, origin): Promise<PasskeyAssertion> {
      const alias = options.allowCredentials[0]
      if (!alias) throw new Error('This server has no key for this device.')
      const authData = concat(await sha256(utf8(options.rpId)), Uint8Array.of(FLAG_UP | FLAG_UV), new Uint8Array(4))
      const data = clientData('webauthn.get', options.challenge, origin)
      const signed = concat(authData, await sha256(data))
      const signature = await keys.sign(alias, toB64url(signed), 'Sign in to sync your notes')
      return { credentialId: alias, clientDataJSON: toB64url(data), authenticatorData: toB64url(authData), signature }
    },
  }
}
