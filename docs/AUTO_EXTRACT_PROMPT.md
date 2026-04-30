# Auto-extract — current state, known issues, fix prompt

A focused brief for fixing the "draw a key + value, then apply to all pages /
PDFs" feature. Self-contained — you can hand this whole file to a new
agent or developer.

---

## 1. What the feature does today

User clicks the magic-wand button to enter **auto-extract setup**:

1. Banner appears at the top of the PDF viewer.
2. User draws a **VALUE** box → field-label picker → assigns it to a field
   like `billing_date`. Highlight is created and saved into
   `session.highlights`.
3. User draws a **KEY** box (the label text on the page, e.g.
   "Billing Date"). The picker is **skipped**; the rect is attached to
   the most-recent value as that pair's key. The key is **not** saved
   as a regular highlight — it lives only in the local `autoPairs`
   state.
4. Repeat for each field.
5. User clicks **Apply to all pages** or **Apply to all open PDFs**.

For each pair the engine then:

1. Reads the source **key text** from inside the key rect.
2. Computes the **offset** = `valueBbox - keyBbox` (in normalized 0-1
   coords).
3. For each target page (other pages in this PDF, or every page of
   every other open PDF), **searches** the page for the key text.
4. On a match, places a value highlight at `keyMatch + offset` with
   `valueBbox.width` / `valueBbox.height` from the source.

Only **value** highlights propagate to targets — keys are reference
points, not extracted data.

Files:
- [src/components/PDFViewer.tsx](../src/components/PDFViewer.tsx) — setup mode, banner UI, `autoPairs`, `resolveAutoPairs`, `handleAutoApplyAllPages`
- [src/pages/Index.tsx](../src/pages/Index.tsx) — `handleAutoApplyAllPdfs` (iterates other sessions)

---

## 2. Fallback chain (what runs when)

### Reading the source key text (`resolveAutoPairs`)
1. **pdfjs `getTextAtRect`** — fast, native-text PDFs.
2. **Backend `/extract-regions` with `strict: true`** — for scanned /
   vector-only PDFs the backend has rasterized + OCR'd.
3. If both return empty: pair is **dropped** with a toast warning
   `Skipping "<field>" — couldn't read its key text`.

### Finding the key on each target page
1. **pdfjs `findTextPositionInPdf`** — substring match on the text layer.
2. **Backend `/search` cascade** — `exact → partial → fuzzy`. Cached
   per-key per-target so each unique key text triggers at most one
   network round-trip per target PDF.
3. If both miss: that field is silently skipped on that page.

### Placement
- New highlight at `(keyMatch.x + offset.x, keyMatch.y + offset.y)`
- Width / height copied from the source value box
- Clamped to `[0, 1]`
- Tagged `isAutoExtracted: true`

---

## 3. Known failure modes — most likely first

### (a) Source key text is empty
The user drew a key box but `getTextAtRect` returned nothing.
Causes:
- **Vector-only PDF** that wasn't rasterized client-side. The frontend
  rasterizer only fires on PDFs with **no text + no images** anywhere.
  A *mixed* PDF (some text, some vector) will skip rasterization and
  the vector pages will return empty key text.
- **Box too small** — pdfjs returns text whose bounding-box centre is
  inside the rect. A tight key box around a centered glyph might miss.
- **Box on whitespace** — user drew over the gap between label and
  value, no text inside.
- **Backend OCR-by-rect not strict** — if `strict: true` isn't honored
  by the backend, it might do label-adjacent smart-detection and
  return the wrong text.

Fix surface: `resolveAutoPairs` in [PDFViewer.tsx:148](../src/components/PDFViewer.tsx#L148).

### (b) Wrong match picked when key text appears multiple times
`findTextPositionInPdf` returns the **first** hit on a page.
Backend search returns all hits but we only use index `[0]`.
Example: a rent-roll page with "Tenant Name" in both the header row
and a footnote — the engine picks the header.

Fix surface: in `handleAutoApplyAllPages` and `handleAutoApplyAllPdfs`,
score candidates by *spatial proximity* to where the key was on the
source. Keep the candidate whose `(x, y)` is closest to the source
key's `(x, y)`. Falls back gracefully when there's only one hit.

### (c) Offset breaks when target layout differs
The offset is captured in **normalized 0-1 coords**. If two PDFs have
different page sizes or the key is at a different relative location,
`keyMatch + offset` lands somewhere wrong.

Concrete example: source PDF puts "Billing Date" at the top with the
date to the right; target PDF puts the date BELOW the label. Same
text content, different layout → value lands in the wrong place.

Fix surface: switch from absolute offset to a **direction + magnitude**
heuristic:
- Capture `direction = sign(value − key)` per axis on the source.
- Look at OCR/text words near the matched key on the target. Pick the
  nearest word in the captured direction; size the value box around it.

This is more code but degrades gracefully.

### (d) Multi-line key text
pdfjs joins line-breaks with spaces; the resulting query may not match
the target's text layer because the wrap point differs. Backend search
might find it via fuzzy mode but only if the query is short.

Mitigation: after reading the source key, strip everything past the
first 4 words; treat that as a search anchor instead of the whole rect.

### (e) Vector pages on `findTextPositionInPdf`
pdfjs has no text layer to search → returns null. We fall back to
backend `/search`, which only works if the backend has OCR'd that page.
If your backend hasn't applied [backend_vector_pdf_fix.py](backend_vector_pdf_fix.py)
yet, vector pages will silently skip. Frontend rasterization handles
this for **uploaded** PDFs — but only at upload time.

### (f) Apply to all pages skips the source page wrong
The engine skips `resolved[0].sourcePage` (the source page of the FIRST
resolved pair). If the user drew different pairs on different pages
of the same PDF, only the first one's source page is skipped — the
others get re-processed and may end up with duplicate highlights.

Fix surface: `handleAutoApplyAllPages` in [PDFViewer.tsx:178](../src/components/PDFViewer.tsx#L178).
Track the set of source pages and skip them all.

### (g) Value box dimensions stay literal
`valueWidth` / `valueHeight` are copied verbatim from the source. On
target pages with different font sizes, the box may clip the value or
include surrounding garbage.

Mitigation: pad the value box by 10-20% of its width/height before
clamping.

---

## 4. Quick diagnostics

When the feature isn't behaving, run these in DevTools while in setup
mode:

```js
// 1. Inspect what was captured during setup
React.findFiber(document.querySelector('[data-pdf-viewer]'))
  // …or just open the PDFViewer component in React DevTools and
  // read the `autoPairs` state.

// 2. Manually probe pdfjs key-text reading
import('@/lib/pdf-extract').then(m =>
  m.getTextAtRect(file, page, { x, y, width, height })
).then(console.log);

// 3. See if the backend can find the key
import('@/lib/api').then(m =>
  m.searchBackend(sessionId, 'Billing Date', 'partial')
).then(console.log);
```

If `getTextAtRect` returns `''` and the backend returns 0 results, the
PDF is vector-only or scanned and the backend hasn't OCR'd it. Either
the upload-time rasterizer didn't fire (mixed PDF) or backend OCR
failed.

---

## 5. Continuation prompt — paste this to start work

> You're improving the auto-extract feature in a React 18 + TypeScript
> + Vite app called Pexl. Read `docs/AUTO_EXTRACT_PROMPT.md` first for
> the full picture.
>
> The feature lets a user draw a (value, key) pair on the source page,
> then propagate value highlights to other pages or PDFs by searching
> for the key text and applying a captured offset. The propagation
> currently misplaces values in some cases.
>
> Implementation:
> - **Setup mode**: `PDFViewer.tsx` — `autoSetupActive`, `autoPairs`,
>   `autoNextStep`. Hooks into `handleLabelSelect` (value side) and the
>   `mouseup` rect commit (key side).
> - **Apply to all pages**: `PDFViewer.tsx` → `handleAutoApplyAllPages`.
> - **Apply to all PDFs**: `Index.tsx` → `handleAutoApplyAllPdfs`,
>   wired via the `onAutoApplyAllPdfs` prop on `PDFViewer`.
> - **Source key reading**: `resolveAutoPairs` — pdfjs `getTextAtRect`
>   first, backend `extractRegions(strict: true)` fallback.
> - **Target key search**: pdfjs `findTextPositionInPdf` first, backend
>   `searchBackend` cascade (exact → partial → fuzzy) fallback.
>
> Constraints:
> - Don't change existing features (Extract, Apply-to-all-pages,
>   Apply-to-all-PDFs from the toolbar, Search, Excel export). Auto-
>   extract is its own code path inside `PDFViewer`.
> - Don't modify the backend — fix everything client-side.
> - The frontend rasterizes vector-only PDFs at upload time via
>   `rasterizeIfVectorOnly`. Don't bypass it.
> - Vector mixed PDFs (some text, some vector pages) currently fall
>   through unhandled — flag any such cases instead of silently dropping
>   pairs.
>
> Pick ONE of the failure modes from § 3 of `AUTO_EXTRACT_PROMPT.md`
> and ship a fix. Smaller changes that improve robustness are better
> than a full rewrite. Show me the diff plus a short test plan
> (e.g. "Open Panorama RR; draw key + value on page 1; click Apply
> to all pages; verify highlights on pages 2-4 line up over the
> right cells").

---

## 6. Suggested fix order (ranked by impact / effort)

1. **(b) Pick closest match** — biggest accuracy win. ~30 lines in two places.
2. **(f) Skip all source pages** — small, prevents duplicates. ~5 lines.
3. **(a) Better empty-key handling** — prompt user to redraw a bigger
   key box instead of silently dropping. Surface count of dropped
   pairs in the toast. ~15 lines.
4. **(g) Padding around value box** — light touch, fixes "value clipped"
   complaints. ~5 lines.
5. **(d) Truncate multi-line keys to 4 words** — small, helps search
   reliability. ~3 lines.
6. **(c) Direction-based placement** — biggest behavioral change. Save
   for a separate iteration.

Run `npx tsc --noEmit -p tsconfig.app.json` after each change.
