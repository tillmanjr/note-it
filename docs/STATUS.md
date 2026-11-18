# Where we are

Checkpoint: 2026-11-18.

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
- **Theme toggle:** a ◐ / ☀ / ☾ button next to Search cycles System → Light → Dark.
  - The choice is saved per device (localStorage `tdjr.theme`).
  - `index.html` sets `data-theme` before first paint, and `src/theme.ts` keeps it current and themes the Tauri title bar.
- **Notes list placement:** a button on the Notes header moves the list between the left pane and a strip above the editor, with a draggable divider. Opening a view expands a collapsed Notes section.
- **Trash:**
  - Empty Trash: the "Empty" action on the Trash row opens a confirmation dialog that shows the note count.
  - In Trash view, the Notes section header reads "Trash (n)" in red, and the rows are muted with a red left edge.

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

## Next (not started; wait for the user's go-ahead)
1. **2c:** server on the DigitalOcean droplet (Node/Fastify + Postgres), Yjs sync, passkeys and device tokens. Ask clarifying questions first, one at a time.
2. **2d:** vault-encrypted note sections (one passphrase, in memory only, re-lock on timeout), including converting Evernote-encrypted blocks.
3. **Milestone 3:** mobile (Capacitor, iOS and Android).

## How to run
- `npm install`, then `npm run desktop` starts the Tauri app (Vite on port 5318).
- `npm run dev -w @tdjr/desktop` serves the same UI in a browser.
- `npm test` and `npm run typecheck` check the code.
- **Real-export check** (git-ignored, prints counts only):
  - Run from `packages/enex`: `ENEX_DIR=../../../evernoteExports2026.11.17 npx vitest run real-exports --disableConsoleIntercept`.
  - Without the flag, the per-file counts don't print.
- **Never commit or print the content of the Evernote exports.**
