import { describe, expect, it } from 'vitest'
import {
  DEFAULT_KDF,
  SectionUnavailable,
  WrongPassphrase,
  changePassphrase,
  createVault,
  currentKeyId,
  decryptSection,
  encryptSection,
  unlockVault,
} from './vault'

// Small Argon2id settings keep the tests fast; the real defaults are checked once below.
const FAST = { alg: 'argon2id', m: 1024, t: 1, p: 1 } as const
const PASS = 'correct horse battery'
const content = [{ type: 'paragraph', content: [{ type: 'text', text: 'PIN 4417' }] }]

describe('vault', () => {
  it('sets up, locks and unlocks with the passphrase only', async () => {
    const { record, keys } = await createVault(PASS, 1000, FAST)
    expect(record.wrap.kdf).toMatchObject({ alg: 'argon2id', m: 1024 })
    expect(JSON.stringify(record)).not.toContain(PASS)
    const section = await encryptSection(keys, record.id, content)
    expect(section.ct).not.toContain('4417')

    const reopened = await unlockVault(PASS, [record])
    expect(await decryptSection(reopened, section)).toEqual(content)
    await expect(unlockVault('wrong passphrase', [record])).rejects.toBeInstanceOf(WrongPassphrase)
  })

  it('keeps vault keys non-extractable once open', async () => {
    const { record } = await createVault(PASS, 1000, FAST)
    const keys = await unlockVault(PASS, [record])
    const key = keys.get(record.id)!
    expect(key.extractable).toBe(false)
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow()
  })

  it('uses a fresh IV every time and detects tampering', async () => {
    const { record, keys } = await createVault(PASS, 1000, FAST)
    const a = await encryptSection(keys, record.id, content)
    const b = await encryptSection(keys, record.id, content)
    expect(a.iv).not.toBe(b.iv)
    expect(a.ct).not.toBe(b.ct)
    const bytes = Uint8Array.from(atob(a.ct), (c) => c.charCodeAt(0))
    bytes[0] ^= 1
    const tampered = { ...a, ct: btoa(String.fromCharCode(...bytes)) }
    await expect(decryptSection(keys, tampered)).rejects.toBeInstanceOf(SectionUnavailable)
  })

  it('changes the passphrase without touching sections', async () => {
    const { record, keys } = await createVault(PASS, 1000, FAST)
    const section = await encryptSection(keys, record.id, content)
    const [rewrapped] = await changePassphrase(PASS, 'a different passphrase', [record], FAST)
    expect(rewrapped.id).toBe(record.id)
    await expect(unlockVault(PASS, [rewrapped])).rejects.toBeInstanceOf(WrongPassphrase)
    const keys2 = await unlockVault('a different passphrase', [rewrapped])
    expect(await decryptSection(keys2, section)).toEqual(content)
    await expect(changePassphrase('nope nope nope', 'whatever else', [record], FAST)).rejects.toBeInstanceOf(WrongPassphrase)
  })

  it('opens both keys when two devices set up a vault offline, and picks the oldest for new sections', async () => {
    const a = await createVault(PASS, 1000, FAST)
    const b = await createVault(PASS, 2000, FAST)
    const fromB = await encryptSection(b.keys, b.record.id, content)
    const keys = await unlockVault(PASS, [b.record, a.record])
    expect(keys.size).toBe(2)
    expect(await decryptSection(keys, fromB)).toEqual(content)
    expect(currentKeyId([b.record, a.record], keys)).toBe(a.record.id)
  })

  it('refuses short passphrases and sections from a key that isn’t open', async () => {
    await expect(createVault('short', 1000, FAST)).rejects.toThrow(/at least/)
    const a = await createVault(PASS, 1000, FAST)
    const b = await createVault('another passphrase', 1000, FAST)
    const section = await encryptSection(b.keys, b.record.id, content)
    await expect(decryptSection(a.keys, section)).rejects.toBeInstanceOf(SectionUnavailable)
  })

  it('works with the real Argon2id settings', async () => {
    const { record } = await createVault(PASS, 1000)
    expect(record.wrap.kdf).toMatchObject(DEFAULT_KDF)
    expect((await unlockVault(PASS, [record])).size).toBe(1)
  }, 30_000)
})
