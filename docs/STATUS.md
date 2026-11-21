# Where we are

Checkpoint: 2026-11-19.

## Done
- **Milestone 1:** editor spike (`spike/editor`, frozen). See [editor-spike.md](editor-spike.md).
- **Milestone 2a:** local Tauri desktop app. Notebooks, hierarchical tags, notes, trash, search overlay, and attachments.
- **Milestone 2b:** Evernote `.enex` import.
  - The user reorganized the exports into 10 notebooks (144 notes).
  - All 10 import with no failures and no lost text.
  - The app's data was dropped and everything was imported again on 2026-11-18.
- **Contrast colors:**
  - Black and white swatches are theme-aware contrast colors (`var(--note-max)` / `var(--note-min)`).
  - Pasted and imported near-black text maps to maximum contrast. Verified after the re-import: 552 runs became `--note-max`, and no literal near-black is left.
  - White stays literal on import (1 run in the exports), so `--note-min` only comes from the editor swatch.
- **App bar and ⚙ menu:** a strip above New note / Search with the app name and a ⚙ button. Its menu holds the theme (System / Light / Dark) and "Import notebooks…" (moved off the Notebooks header).
- **Theme:** System / Light / Dark, chosen in the ⚙ menu.
  - The choice is saved per device (localStorage `tdjr.theme`).
  - `index.html` sets `data-theme` before first paint, and `src/theme.ts` keeps it current and themes the Tauri title bar.
- **Notes list placement:** a button on the Notes header moves the list between the left pane and a strip above the editor, with a draggable divider. Opening a view expands a collapsed Notes section.
- **Trash:**
  - Empty Trash: the "Empty" action on the Trash row opens a confirmation dialog that shows the note count.
  - In Trash view, the Notes section header reads "Trash (n)" in red, and the rows are muted with a red left edge.

- **2c-1 sync (2026-11-18):** Fastify + Postgres server in `apps/server`, per-field last-writer-wins metadata, Yjs bodies, attachments, a live WebSocket nudge, and device codes. Design and how to run it are in [sync.md](sync.md).
  - End-to-end tests pass against real Postgres: first sync, merging, delete forever, live nudge, and revoke.
  - Checked in the browser against a scratch server: connect, Add a device, Devices, a live edit appearing in the open note, and disconnect.
  - The user's real notes are connected and syncing to the local server (2026-11-18).
- **Since 2c-1:** tag picker dropdown (picks tags by id), tag names drop a leading "+" and surrounding whitespace, an always-visible sync status in the app bar, and the project's own ports (5318 desktop, 5319 sync, 5320 Postgres).
- **UI streamlining (2026-11-19):**
  - Switching notebook, tag or All notes reopens the last note opened there (else the first).
  - Editor pane: the title is the note's first line; a one-row toolbar (text style first, Aa for font and size, color, highlight and list dropdowns); notebook, tags, edited time and trash sit in a strip fixed to the bottom (notebook left, time and trash right, tags wrap between and below).
  - Note counts beside notebooks, tags (sub-tags included) and All notes.
  - Notebooks and Tags open as an accordion.
  - Dropdown lists follow the theme; a delayed Tooltip component replaces native tooltips in the note footer; every clickable control reacts to hover.
- **Repo:** pushed to https://github.com/tillmanjr/note-it on 2026-11-19. From then on, work goes on branches and PRs (the user opens PRs from the push link; git CLI, no gh).
- **Droplet spec:** [recommended-droplet.md](recommended-droplet.md).
- **Droplet up and hardened (2026-11-20):** `tdjr-notes`, DNS for `notes.tillmanjr.com` in place, cloud firewall, `deploy/01-harden.sh` run and verified (only `tillman` with the `notes_droplet` key gets in; root refused; kernel 6.8.0-151). Details in [deploy.md](deploy.md). Nothing app-related is installed yet.
- **Leak scanning (2026-11-20):** gitleaks pre-commit hook plus a CI scan of the full history; history was clean when added.
- **2c-2 passkeys (2026-11-20):** each device requests access with its own device-bound Windows Hello passkey, an admin approves it by match code (`notes-admin`, over SSH in production), and the app signs in once per launch (24 h session, in memory only). Design in [passkeys.md](passkeys.md).
  - 11 end-to-end tests pass, using a software authenticator: approval by code, denied/revoked/unknown devices, socket closing on revoke, forged/replayed/foreign signatures, session expiry, refusing synced passkeys.
  - Tested for real with Windows Hello (fingerprint): requested, approved, signed in, the user's notes synced (2026-11-20). Needed "Save passkeys to this Windows device" turned on (see passkeys.md, Windows setup).
- **Deployed (2026-11-20):** sync server 0.1.0 runs on the droplet at https://notes.tillmanjr.com (native Postgres 16, Caddy, Node 24, sandboxed systemd service). Releases come from the Server release workflow and are installed with `sudo notes-deploy`. The desktop app is joined to it and synced. Nightly age-encrypted backups work, and `npm.cmd run backup:pull` copies them to `~/notes-backups`; decrypting with the PC's key was checked. Runbook in [deploy.md](deploy.md).
  - First-install fixes are on `fix/caddy-log-owner`: validating the Caddyfile as root made the log file root-owned; `backup:pull` used `sftp -b`, which can't ask for the key passphrase.
  - The dev build's Request access defaults to `http://localhost:5319`; type `https://notes.tillmanjr.com` to use the droplet. On this PC, use `npm.cmd` in Windows PowerShell 5.1 (its execution policy blocks `npm.ps1`).
- **2d vault sections (2026-11-20, branch `feature/vault`):** select text → 🔒 encrypts it into a section. One passphrase (Argon2id) unwraps a random vault key, which is kept only in memory; it locks after 3 minutes idle, when the window is hidden, or with ⚙ → Lock vault. Change passphrase rewraps the key. Attachments can't go inside a section. The exports hold no Evernote-encrypted text, so there was nothing to convert. Design in [vault.md](vault.md).
  - Tests: core crypto (wrong passphrase, tampering, rewrap, two keys) and vault keys syncing through the server. Checked in the browser build: set up, encrypt, edit, lock, wrong passphrase, unlock, reload, remove encryption. The auto-lock timer and Change passphrase dialog weren't clicked through yet.
  - **The server must run 0.2.0 before a synced device uses the vault:** older servers reject the new `vault_key` records, which stops that device's sync.
- **Credentials:** be aggressively careful from here on; rules in [deploy.md](deploy.md#credentials).

Details are in [milestone-2.md](milestone-2.md); the overall plan is in [design.md](design.md).

## Open threads
- **Optional:** widen near-black to include the grays `#424242`/`#444444` (10 runs left after the re-import). The user hasn't decided.
- **One "Recipes - Food" note has light text on no background.** It has about 260 runs in VS Code dark-theme syntax colors (`#cccccc`, `#9cdcfe`, …). That's faithful to the source, but hard to read in light mode. The user could fix it by hand, or we could add a light-text rule.
- **Real-export test workaround:** jsdom 29 crashes on some mixes of background shorthand and longhand (e.g. `background: …; zoom: 1; background-color: …`). The git-ignored local test drops `background*` declarations only from styles jsdom can't parse. Browsers (and the app) parse these fine.
- **Known gaps:**
  - opening or previewing non-image attachments
  - downloading remote web-clip images (21 in the current exports)
  - dragging tags and notes
  - saved searches
  - note history
  - **Backlog:** breadcrumbs (something like them), e.g. a trail showing where you are (notebook → note) and where you came from, to step back. Shape not yet decided.

## Next (not started; wait for the user's go-ahead)
Now: more UI streamlining from the user.

**Then, on the user's go-ahead:**
1. **Milestone 3:** mobile (Capacitor, iOS and Android).

## How to run
- Install gitleaks (`winget install Gitleaks.Gitleaks`); the pre-commit hook needs it.
- `npm install`, then `npm run desktop` starts the Tauri app (Vite on port 5318).
- `npm run dev -w @tdjr/desktop` serves the same UI in a browser.
- `npm test` and `npm run typecheck` check the code. The server's end-to-end tests need `npm run db:up -w @tdjr/server`; they're skipped otherwise.
- Sync server: `npm run db:up -w @tdjr/server` (Postgres on 127.0.0.1:5320), then `npm run server` (http://localhost:5319). Approve devices with `npm run admin -w @tdjr/server -- pending` / `approve <CODE>`.
- **Don't add vitest or `@tdjr/core` to `apps/server/package.json`.** npm 11 then drops rolldown's native bindings from the lockfile and breaks Vite and Vitest. The server uses the root vitest and the workspace link instead.
- **Real-export check** (git-ignored, prints counts only):
  - Run from `packages/enex`: `ENEX_DIR=../../../evernoteExports2026.11.17 npx vitest run real-exports --disableConsoleIntercept`.
  - Without the flag, the per-file counts don't print.
- **Never commit or print the content of the Evernote exports.**
