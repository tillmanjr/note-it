# Where we are

Checkpoint: 2026-11-17, after commit `23dde4e`. The working tree is clean.

## Done
- **Milestone 1:** editor spike (`spike/editor`, frozen). See [editor-spike.md](editor-spike.md).
- **Milestone 2a:** local Tauri desktop app. Notebooks, hierarchical tags, notes, trash, search overlay, and attachments.
- **Milestone 2b:** Evernote `.enex` import. Verified on the real exports: Recipes (55), Serial Numbers (42), and ZeeMee (8).
- **Recent editor changes:**
  - Black and white swatches are theme-aware contrast colors (`var(--note-max)` / `var(--note-min)`).
  - Pasted and imported near-black text maps to maximum contrast.

Details are in [milestone-2.md](milestone-2.md); the overall plan is in [design.md](design.md).

## Open threads
- **Optional:** widen near-black to include the grays `#444`–`#555` (about 27 runs in the exports). The user hasn't decided.
- **Notes imported before `23dde4e`** keep literal black. To fix them, delete the notebook and import again (duplicates are skipped otherwise).
- **Known gaps:**
  - opening or previewing non-image attachments
  - downloading remote web-clip images
  - dragging tags and notes
  - saved searches
  - note history

## Next (not started; wait for the user's go-ahead)
1. **2c:** server on the DigitalOcean droplet (Node/Fastify + Postgres), Yjs sync, passkeys and device tokens. Ask clarifying questions first, one at a time.
2. **2d:** vault-encrypted note sections (one passphrase, in memory only, re-lock on timeout), including converting Evernote-encrypted blocks.
3. **Milestone 3:** mobile (Capacitor, iOS and Android).

## How to run
- `npm install`, then `npm run desktop` starts the Tauri app (Vite on port 5318).
- `npm run dev -w @tdjr/desktop` serves the same UI in a browser.
- `npm test` and `npm run typecheck` check the code.
- Real-export check (git-ignored, prints counts only): `ENEX_DIR=../evernoteExports2026.11.17 npx vitest run real-exports` in `packages/enex`.
- **Never commit or print the content of the Evernote exports.**
