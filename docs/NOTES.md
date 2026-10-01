# Pipeline Retro — 2026-10-01

## What slowed this run down
- Building features before the test harness existed. Several bugs (fields deleted by their own cleanup step, highlights read as page content, grey row lines missed) were only found by rendering outputs by hand. The fixture suite should come first.
- Planning row moves one at a time. Each fix to that design added edge cases; the independent code review found the real flaw (adjacent rows wiped the page). Planning all row operations together in original coordinates was the right model from the start.
- Mid-task requests (phone use, hosting, a final PDF, error handling) arrived while building. Answering them in short messages kept work moving; there was no need to stop.

## What required a guess instead of a clear decision
- History storage: browser-only with "Download both", or a login-backed link. Daniel accepted the browser-only version; cross-device history was not built.
- Default for "close the gap": off, because table borders vary between forms. Revisit once she has used it on more forms.
- Whether "Additional comments" should keep the case-manager question. It was applied as written and flagged.

## What should change next time
- Write `tests/fixtures.py` and the suite before the first feature. Include adjacent and overlapping operations on the same page from day one.
- Run the independent code review earlier, after the first working build rather than at the end. It caught 18 issues that self-review missed.
- When refactoring for memory or performance, re-shoot screenshots immediately. The canvas-to-img change broke page sizing, and the design critique only caught it later.
- Check a user's file against any generated source before regenerating it. Her copy had field edits the source didn't have.

## Bug patterns worth remembering
- **pdf.js text items don't map 1:1 to content-stream operators.** One `Tj` can become two items. Never assume an item boundary is an operator boundary; guard with "touching neighbours".
- **pdf-lib field defaults:** `addToPage` adds a black border and white background unless `borderColor`/`backgroundColor` keys are present (even as `undefined`).
- **pdf-lib `save()` regenerates field appearances.** After removing fields, pass `updateFieldAppearances:false` or it throws.
- **Removing a widget** must also remove its field from the AcroForm, and new widgets must be excluded from cleanup sweeps over the same area.
- **CSS selectors on generic tags** (`.steps li span`, `.done`) collided with new markup. Use classes for anything styled.
- **Owner-password PDFs** open in pdf.js but fail in pdf-lib. Check writability when the file is opened, not at save.
