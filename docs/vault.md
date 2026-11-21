# Vault-encrypted sections (milestone 2d)

Decided with the user on 2026-11-20. Refines "Encrypted sections" in [design.md](design.md).

## Decisions

| Area | Decision |
|---|---|
| Unlock | **Passphrase only.** No Windows Hello shortcut: nothing that can open the vault is stored on any device. |
| Scope | One unlock opens **the whole vault** for a while: every encrypted section in any note shows without asking again. It locks after **3 minutes** without activity in an open section, when the app is minimized or hidden, or with ⚙ → Lock vault. |
| Content | **Text and formatting** (paragraphs, lists, checklists, tables, links, colors). Attachments can't go inside: their files live separately on the server and would stay readable there. Encrypting a selection that holds one explains that first. |
| Evernote | The exports hold no Evernote-encrypted text (0 `en-crypt` blocks in all 10 files), so there's nothing to convert. Imported Evernote blocks stay locked as they are. |
| One vault | All devices share one vault. Its key records sync like other records; the passphrase never leaves the device it's typed on. |
| Lost passphrase | Unrecoverable, by design (no escrow). Setting up says so and asks for the passphrase twice. |

## Crypto

- **Vault key:** a random 256-bit AES-GCM key, created once when the vault is set up. Every section is encrypted with it (a fresh 96-bit IV each time).
- **Passphrase key:** Argon2id (64 MiB, 3 passes, 1 lane, 16-byte random salt; parameters stored with the key record) turns the passphrase into a key that **wraps** the vault key with AES-GCM. A wrong passphrase fails the GCM check, so no separate verifier is needed.
- **Change passphrase** rewraps the vault key under the new passphrase. Sections aren't touched, so it's instant and can't conflict with offline edits on other devices. (This replaces design.md's "re-encrypt all blocks".) It doesn't help if an old passphrase *and* the old wrapped key both leaked; re-encrypting everything under a new key could be added for that.
- **Key records** (kind `vault_key`, id = key id): `kdf` (algorithm, parameters, salt), `wrapped` (IV + wrapped key), `created_at`, `deleted_at`. Normally there's exactly one. If two devices set up a vault while both offline, both keys survive: each section names its key id, and unlocking opens every key the passphrase opens.
- **Section node** `vaultSection` (a TipTap atom): `{ v: 1, kid, iv, ct }`. The plaintext is the section's ProseMirror JSON. The AES-GCM additional data is a fixed label with the version, so a section can be copied between notes and still opens.
- Crypto is WebCrypto (`crypto.subtle`) plus `hash-wasm` for Argon2id. Keys live in memory as non-extractable `CryptoKey`s and are dropped on lock.

## Editing

- Select content → 🔒 in the toolbar (Encrypt selection). The first time, it asks to set up the vault; when locked, it asks for the passphrase.
- A locked section shows a bar: 🔒 Encrypted section · Show. When the vault is open it shows its content in an inner editor, held in memory only, with Lock, and Remove encryption (puts the content back as normal text).
- Edits re-encrypt the section as a whole (new IV) shortly after typing stops and on lock. Only ciphertext reaches the note's Yjs document, so sync, the server, backups and search see ciphertext only. Two devices editing the same open section at once: the later save wins for that section.
- Search and snippets skip sections (they contribute no text).

## Pieces

- `packages/core/src/vault.ts`: key setup, unlock, rewrap, section encrypt/decrypt (no UI).
- `packages/editor/src/extensions/vaultSection.ts`: the node and its view.
- Desktop: setup / unlock / change-passphrase dialogs, the lock timer, ⚙ → Vault.
