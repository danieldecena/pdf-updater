# PDF Change Updater

**Open it:** https://danieldecena.github.io/pdf-updater/ (works on phones and computers; add it to your home screen).

A single offline web page that applies reviewer comments to PDF forms. Open a marked-up PDF (highlights, sticky notes, cross-outs), check the proposed changes, compare before/after, and download a clean updated copy. Nothing is uploaded: everything runs in the browser on the person's own device.

Built for a non-technical user who updates Island Health CAA supplemental forms. Styled with Daniel's App Kit.

## What it does

- **Reads reviewer comments** (Acrobat, Preview, Edge, Chrome): highlights, underlines, cross-outs, sticky notes, insert marks, replies. Drawings and stamps are listed and removed.
- **Understands the note**: "change to: X", "can we change to, X", "should read X", `Change "A" to "B"`, "let's remove this", "remove and add instead: …", "make this the last line in this section". Questions and vague notes are flagged **Needs you** instead of guessed.
- **Edits the PDF properly**: removed and replaced wording is deleted from the page where the PDF stores it on its own; where it's joined to other text (a label and its blank line), it's covered instead. New text uses a close font (Carlito for Calibri/Aptos, Liberation Sans/Serif for Arial/Times) in the original colour. Fill-in fields keep working; `_` becomes a checkbox, `___` a text box, and "Comment:" gets a box. Header and footer changes can apply to every page.
- **Moves rows and closes gaps**: rows (and their fill-in boxes) slide up when one is removed, or move to the end of a section. Links, bookmarks and tags are re-pointed.
- **Lets her edit by hand**: drag across text on the page (or tap **Mark a change** on a phone) to create a change.
- **Shows before/after** for every change, plus a side-by-side page view, before anything is downloaded.
- **Keeps history** in the browser (IndexedDB): every downloaded version, its original and a change list; **Continue editing** starts a new round (v2, v3…). **Download both** gives a zip of original + updated + changes.
- **Fails safely**: password-protected, locked-for-editing, XFA, scanned and rotated pages, signatures and very large files all get a plain-language message; the original is never modified.

## Using it

- **Link:** https://danieldecena.github.io/pdf-updater/ (served from `index.html` at the repo root; rebuild with `python3 build.py && cp dist/index.html index.html`).
- **Computer, offline:** open `index.html` (or the delivered `PDF Change Updater.html`) in Chrome, Safari, Edge or Firefox. No install, no account. Some work email systems strip `.html` attachments; zip it or share by Drive/link.
- **Phone:** host the same file on any static host (e.g. GitHub Pages) and open the link; it can be added to the home screen. Files still stay on the phone.

## Developing

Requires Node (for the pinned libraries), Python 3, and for tests: `playwright` (Python) with Chromium, `pymupdf`, `reportlab`.

```bash
npm install          # pdfjs-dist 3.11.174, pdf-lib 1.17.1, @pdf-lib/fontkit 1.1.1 (pinned)
python3 build.py     # -> dist/index.html (one file, ~3.6 MB, everything inlined)
npm test             # build + fixture PDFs + end-to-end suite (62 checks)
```

`scripts/subset_fonts.sh` regenerates `fonts/` (Latin subsets of Carlito and Liberation, SIL OFL).

### Layout

| Path | What it is |
|---|---|
| `src/engine.js` | Reads the PDF (pdf.js), interprets notes, finds text, page analysis (row edges, sections, ink colour) |
| `src/scrub.js` | Content-stream tokenizer that deletes text runs inside removed areas; bails out on anything unusual |
| `src/apply.js` | Writes the PDF with pdf-lib: covers, new text, new fields, widget removal; pass 2 rebuilds pages from strips to move/close rows |
| `src/store.js` | History in IndexedDB and a small stored-zip writer |
| `src/app.js` | Screens, cards, page viewer, drag-to-mark, compare, download |
| `src/styles.css`, `src/shell.html` | App Kit tokens and markup (with a CSP that blocks all network access) |
| `build.py` | Inlines app, libraries, pdf.js worker and fonts into `dist/index.html` |
| `tests/` | `fixtures.py` makes PDFs for each feature and failure; `suite.py` drives the built file in Chromium; `real/` holds the two real reviewer PDFs |

### Things that aren't obvious

- pdf.js runs with `isEvalSupported:false` (blocks CVE-2024-4367); keep it.
- Page analysis uses a second render with annotations **off**, so reviewer highlights don't look like page content.
- All row operations on a page are planned together in original coordinates and applied in one rebuild (planning them one by one lost content when rows were adjacent).
- Text is only deleted from the content stream when a whole text run sits inside a removed area; partial edits rewrite a stand-alone run, otherwise they fall back to covering.
- `window.__app` is a test hook used by `tests/`.

## Known limits

Scanned pages can't be edited; rotated pages are skipped; rows can't move between pages; very long rewrites into a small space are set smaller (min 7 pt) and flagged. For big restructures, rebuild the form instead (see the `pdf-comment-updater` skill).
