import { invoke } from '@tauri-apps/api/core'
import { nativeKeyPasskeys, type NativeKeys, type PasskeyAssertion, type PasskeyCreated, type Passkeys } from '@tdjr/core'
import { runningInCapacitor, runningInTauri } from '.'

// This device's passkey. On the tablet: a Keystore device key (see below). In Tauri: Windows Hello through the Rust side (src-tauri/src/passkey.rs), which puts
// the server's origin in the client data. In the browser dev build: navigator.credentials, which works only
// when the page's domain is the server's passkey domain (localhost in development).

const bytes = (b64url: string) => Uint8Array.from(atob(b64url.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
const b64url = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

const tauriPasskeys: Passkeys = {
  create: (options, origin) => invoke<PasskeyCreated>('passkey_create', { options, origin }),
  get: (options, origin) => invoke<PasskeyAssertion>('passkey_get', { options, origin }),
}

const browserPasskeys: Passkeys = {
  async create(o) {
    const cred = (await navigator.credentials.create({
      publicKey: {
        rp: { id: o.rpId, name: o.rpName },
        user: { id: bytes(o.userId), name: o.userName, displayName: o.userName },
        challenge: bytes(o.challenge),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
        attestation: 'none',
        timeout: o.timeoutMs,
      },
    })) as PublicKeyCredential | null
    if (!cred) throw new Error('No passkey was created.')
    const res = cred.response as AuthenticatorAttestationResponse
    return {
      credentialId: b64url(cred.rawId),
      clientDataJSON: b64url(res.clientDataJSON),
      attestationObject: b64url(res.attestationObject),
      transports: res.getTransports?.() ?? [],
    }
  },
  async get(o) {
    const cred = (await navigator.credentials.get({
      publicKey: {
        rpId: o.rpId,
        challenge: bytes(o.challenge),
        allowCredentials: o.allowCredentials.map((id) => ({ type: 'public-key' as const, id: bytes(id) })),
        userVerification: 'required',
        timeout: o.timeoutMs,
      },
    })) as PublicKeyCredential | null
    if (!cred) throw new Error('No passkey was used.')
    const res = cred.response as AuthenticatorAssertionResponse
    return {
      credentialId: b64url(cred.rawId),
      clientDataJSON: b64url(res.clientDataJSON),
      authenticatorData: b64url(res.authenticatorData),
      signature: b64url(res.signature),
      userHandle: res.userHandle ? b64url(res.userHandle) : undefined,
    }
  },
}

// The tablet: a Keystore device key presented as a passkey (docs/mobile.md). Loaded lazily so the desktop
// build doesn't pull in the Capacitor plugins.
const lazyDeviceKeys: NativeKeys = {
  createKey: async (alias) => (await import('./capacitor')).deviceKeys.createKey(alias),
  sign: async (alias, data, reason) => (await import('./capacitor')).deviceKeys.sign(alias, data, reason),
}

export const passkeys: Passkeys = runningInTauri ? tauriPasskeys : runningInCapacitor ? nativeKeyPasskeys(lazyDeviceKeys) : browserPasskeys
