import { argon2id } from 'hash-wasm'
import { ulid } from 'ulid'
import { fromBase64, toBase64 } from './encoding'

// Vault-encrypted note sections (docs/vault.md). No UI and no storage here: callers keep the key records
// (synced as kind `vault_key`) and the sections' attributes.
//
// A random AES-256-GCM vault key encrypts every section. The passphrase never encrypts sections directly:
// Argon2id turns it into a key that wraps the vault key, so changing the passphrase rewraps one small record.
// A wrong passphrase fails the GCM check while unwrapping. Unwrapped keys are non-extractable CryptoKeys.

export interface KdfParams {
  alg: 'argon2id'
  /** Memory in KiB. */
  m: number
  /** Passes. */
  t: number
  /** Lanes. */
  p: number
  /** base64 */
  salt: string
}

/** The synced `wrap` field of a vault key record: how to derive the passphrase key, and the wrapped vault key. */
export interface KeyWrap {
  v: 1
  kdf: KdfParams
  /** base64 */
  iv: string
  /** base64: the vault key encrypted with the passphrase key. */
  key: string
}

export interface VaultKeyRecord {
  id: string
  wrap: KeyWrap
  createdAt: number
}

/** The attributes of a `vaultSection` node. */
export interface SectionCipher {
  v: 1
  /** The vault key's id. */
  kid: string
  /** base64 */
  iv: string
  /** base64 */
  ct: string
}

/** Open vault keys by id. */
export type VaultKeys = Map<string, CryptoKey>

export class WrongPassphrase extends Error {
  constructor() {
    super('That passphrase doesn’t open the vault.')
  }
}

export class SectionUnavailable extends Error {}

/** 64 MiB, 3 passes: a few hundred milliseconds here, and costly to guess at scale. */
export const DEFAULT_KDF: Omit<KdfParams, 'salt'> = { alg: 'argon2id', m: 64 * 1024, t: 3, p: 1 }
export const MIN_PASSPHRASE_LENGTH = 10

const WRAP_AAD = new TextEncoder().encode('tdjr-notes vault key v1')
const SECTION_AAD = new TextEncoder().encode('tdjr-notes vault section v1')
const AES = { name: 'AES-GCM', length: 256 } as const
const subtle = () => globalThis.crypto.subtle
const random = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n))
const buf = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>

async function passphraseKey(passphrase: string, kdf: KdfParams): Promise<CryptoKey> {
  const raw = await argon2id({
    password: passphrase.normalize('NFC'),
    salt: fromBase64(kdf.salt),
    parallelism: kdf.p,
    iterations: kdf.t,
    memorySize: kdf.m,
    hashLength: 32,
    outputType: 'binary',
  })
  return subtle().importKey('raw', buf(raw), AES, false, ['wrapKey', 'unwrapKey'])
}

async function wrapWith(passphrase: string, vaultKey: CryptoKey, params: Omit<KdfParams, 'salt'>): Promise<KeyWrap> {
  const kdf: KdfParams = { ...params, salt: toBase64(random(16)) }
  const iv = random(12)
  const kek = await passphraseKey(passphrase, kdf)
  const wrapped = await subtle().wrapKey('raw', vaultKey, kek, { name: 'AES-GCM', iv: buf(iv), additionalData: WRAP_AAD })
  return { v: 1, kdf, iv: toBase64(iv), key: toBase64(new Uint8Array(wrapped)) }
}

async function unwrapWith(passphrase: string, wrap: KeyWrap, extractable: boolean): Promise<CryptoKey | null> {
  if (wrap.v !== 1 || wrap.kdf.alg !== 'argon2id') return null
  const kek = await passphraseKey(passphrase, wrap.kdf)
  try {
    return await subtle().unwrapKey(
      'raw',
      buf(fromBase64(wrap.key)),
      kek,
      { name: 'AES-GCM', iv: buf(fromBase64(wrap.iv)), additionalData: WRAP_AAD },
      AES,
      extractable,
      ['encrypt', 'decrypt'],
    )
  } catch {
    return null // wrong passphrase (the GCM tag doesn't match)
  }
}

/** Sets up a vault: a new random vault key, wrapped with the passphrase. */
export async function createVault(
  passphrase: string,
  now = Date.now(),
  params = DEFAULT_KDF,
): Promise<{ record: VaultKeyRecord; keys: VaultKeys }> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) throw new Error(`Use at least ${MIN_PASSPHRASE_LENGTH} characters.`)
  const extractable = await subtle().generateKey(AES, true, ['encrypt', 'decrypt'])
  const wrap = await wrapWith(passphrase, extractable, params)
  const record: VaultKeyRecord = { id: ulid(now), wrap, createdAt: now }
  // Keep only a non-extractable copy in memory.
  const keys = await unlockVault(passphrase, [record])
  return { record, keys }
}

/** Opens every vault key this passphrase unwraps. Throws WrongPassphrase if it opens none. */
export async function unlockVault(passphrase: string, records: VaultKeyRecord[]): Promise<VaultKeys> {
  const keys: VaultKeys = new Map()
  for (const r of records) {
    const key = await unwrapWith(passphrase, r.wrap, false)
    if (key) keys.set(r.id, key)
  }
  if (!keys.size) throw new WrongPassphrase()
  return keys
}

/** Rewraps the vault keys the old passphrase opens under a new one. Sections stay as they are. */
export async function changePassphrase(
  oldPassphrase: string,
  newPassphrase: string,
  records: VaultKeyRecord[],
  params = DEFAULT_KDF,
): Promise<VaultKeyRecord[]> {
  if (newPassphrase.length < MIN_PASSPHRASE_LENGTH) throw new Error(`Use at least ${MIN_PASSPHRASE_LENGTH} characters.`)
  const changed: VaultKeyRecord[] = []
  for (const r of records) {
    const key = await unwrapWith(oldPassphrase, r.wrap, true)
    if (key) changed.push({ ...r, wrap: await wrapWith(newPassphrase, key, params) })
  }
  if (!changed.length) throw new WrongPassphrase()
  return changed
}

/** Encrypts a section's content (its ProseMirror JSON) with a fresh IV. */
export async function encryptSection(keys: VaultKeys, kid: string, content: unknown): Promise<SectionCipher> {
  const key = keys.get(kid)
  if (!key) throw new SectionUnavailable('That vault key isn’t open.')
  const iv = random(12)
  const plain = new TextEncoder().encode(JSON.stringify(content))
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: SECTION_AAD }, key, plain)
  return { v: 1, kid, iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) }
}

export async function decryptSection(keys: VaultKeys, cipher: SectionCipher): Promise<unknown> {
  const key = keys.get(cipher.kid)
  if (cipher.v !== 1 || !key) throw new SectionUnavailable('This section was encrypted with a vault key that isn’t open.')
  try {
    const plain = await subtle().decrypt(
      { name: 'AES-GCM', iv: buf(fromBase64(cipher.iv)), additionalData: SECTION_AAD },
      key,
      buf(fromBase64(cipher.ct)),
    )
    return JSON.parse(new TextDecoder().decode(plain))
  } catch {
    throw new SectionUnavailable('This section is damaged and can’t be decrypted.')
  }
}

/** The key new sections use: the oldest one that's open, so every device converges on the same key. */
export function currentKeyId(records: VaultKeyRecord[], keys: VaultKeys): string | null {
  const open = records.filter((r) => keys.has(r.id)).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  return open[0]?.id ?? null
}
