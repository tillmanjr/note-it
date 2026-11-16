# Editor spike (milestone 1)

Goal: prove that a TipTap 3 / ProseMirror editor matches Evernote's formatting before building
sync, storage or mobile. Code: `spike/editor` (`npm install && npm run dev`).

## Decisions made in the spike

- **Schema** (`src/editorExtensions.ts`): StarterKit (headings, lists, bold/italic/underline/strike,
  code, links, rules, undo), nested task lists, tables (resizable), images, text style (font family,
  size, color, background), multicolor highlight, alignment, and two custom extensions.
- **Real indentation** (`src/extensions/indent.ts`): numeric `indent` attribute (0–10) on paragraphs
  and headings, rendered as `margin-left` + `data-indent`. Tab / Shift-Tab indent and outdent;
  Backspace at the start of an indented block outdents. In lists Tab nests items; in tables Tab
  moves between cells. Pasted `margin-left` / `padding-left` (px, pt, em) is converted to levels at 40px each,
  which matches Evernote's ENML indentation.
- **Paste fidelity** (`src/extensions/paste.ts`): strips scripts/styles/iframes and tracking pixels;
  unwraps the Google Docs `<b id="docs-internal-guid…">` wrapper; converts styled spans
  (bold/italic/underline/strike) into real marks and keeps only the styles the schema represents;
  embeds pasted or dropped image files.
- **Canonical colors** (`src/extensions/colors.ts`): ProseMirror writes `style` through
  `dom.style.cssText`, so browsers rewrite hex colors to `rgb()`. All colors are stored as lowercase hex
  (transparent → none), from both parsing and commands.
- **Selection format bar** (`src/SelectionFormatBar.tsx`): right-click inside selected text opens a
  compact bar above it (font size, bold, italic, code, text color, highlight). It stays open while
  formatting and closes on selection change, Escape or blur. Right-click elsewhere, or
  Shift+right-click, keeps the browser's context menu.
- **Canonical JSON** (`src/canonical.ts`): `""` and `null` both mean "unset" for TipTap text-style
  attributes; documents are canonicalized before saving or comparing.

## Verified (automated, in Chrome)

- Tab / Shift-Tab / Backspace indent behavior; Tab nests checklist items; Tab moves table cells.
- Google Docs paste: no false bold, `36pt` margin → indent 1, `80px` padding → indent 2, bold +
  color + font family kept as marks, 1×1 tracking images removed.
- JSON → HTML → JSON is lossless for the sample note plus pasted headings, tables, nested
  ordered lists, colors, fonts and sizes ("Check HTML round-trip" button).

User-verified: pasting GitHub repo lists and tables works well; text color is visible while selected.

## For you to evaluate by hand

1. Day-to-day typing: indent/outdent, list behavior at boundaries (Enter on empty item, Backspace
   at start of item), checklists.
2. Paste from your real sources (web articles, Google Docs, Word, emails, an Evernote note). Use
   the debug pane's "Last raw pasted HTML" to show me anything that came out wrong.
3. Tables: add/remove rows/cols, column resizing, pasting tables.
4. Anything you use in Evernote that's missing here.

## Known gaps / follow-ups

- Lists themselves can't take a block indent (only paragraphs/headings); list nesting covers most cases.
- Pasted remote images keep their URL; the real app downloads them into attachments.
  Spike images are data URLs in localStorage (large images may exceed its quota).
- Pasting into a non-empty paragraph merges the first pasted paragraph into it (standard ProseMirror).
- Not in the spike: encrypted blocks, attachments other than images, Yjs, `.enex` import.
- Bundle is ~500 KB unsplit; fine for desktop/Capacitor, revisit later.
