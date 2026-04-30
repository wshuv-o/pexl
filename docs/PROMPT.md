# Pexl — full-stack handoff prompt

Drop this whole file into a fresh agent / new-dev onboarding / backend
dev's inbox. It captures what the app does, how the frontend is wired,
what the backend expects, and the still-fragile bits.

---

## 1. What Pexl is

A web app for **scraping structured fields out of PDFs** (utility bills,
bank statements, appraisals, lease contracts, tax forms). Users upload
PDFs, draw highlight boxes over the fields they want, click *Extract*,
and get a typed Excel workbook back.

Branding: **Pexl** — replaced an older "utility-bill-scraper" name. App
runs at `pexl.bulkscraper.cloud`; backend at `pexlbackend.bulkscraper.cloud`.

---

## 2. Frontend

Stack:
- **React 18 + TypeScript + Vite**
- **Tailwind + shadcn/ui** (Radix primitives)
- **react-pdf / pdfjs-dist** for rendering
- **xlsx-js-style** for utility / appraisal / tax / lease export, **ExcelJS**
  for bank statements (formulas + roll-up)
- **pdf-lib** for client-side vector → image-PDF conversion
- **JSZip** for batched OCR-PDF downloads
- React Router for routing; sessions live in a module-level cache so
  navigating to `/admin` and back doesn't drop the open PDFs.

### Top-level routes
- `/login` — auth (JWT in localStorage)
- `/` — main app (upload, viewer, Excel panel)
- `/admin` — usage dashboard (admin role only)

### Document types
`utility_bill | bank_statement | appraisal | lease_contract | tax`. Each
has a per-type field schema in [`src/types/utilscraper.ts`](../src/types/utilscraper.ts).

### Key components

| Component | Purpose |
|---|---|
| [Index.tsx](../src/pages/Index.tsx) | Sessions / tabs / extraction orchestration / apply-to-all-PDFs |
| [PDFViewer.tsx](../src/components/PDFViewer.tsx) | Page rendering, drawing, search, auto-extract setup |
| [ViewerToolbar.tsx](../src/components/ViewerToolbar.tsx) | Toolbar buttons, "Selected & Apply" popover |
| [ExcelPanel.tsx](../src/components/ExcelPanel.tsx) | Live extraction table; merge dialog before export |
| [Admin.tsx](../src/pages/Admin.tsx) | Usage dashboard with per-doc-type breakdown |

### Cell typing in Excel export
[`src/lib/excel-export.ts`](../src/lib/excel-export.ts) writes typed cells (not strings):
- date fields → `t:'d'`, format `mm/dd/yyyy`
- amount fields → `t:'n'`, format `"$"#,##0.00`
- year / count fields → `t:'n'`, format `0`
- everything else → string
Field-set membership is mirrored in [`src/lib/api.ts`](../src/lib/api.ts) so backend snap-format matches.

### Utility-bill export — pivot layout
The utility export is a **pivot table** (one block per provider+utility-type,
month-bucketed columns). Spec:
- **Layout (cols):** col A blank · Folder Path · File Name · Utility Items
  (green) · Utility Provider (orange) · Account # (white) · month columns
  · year-total columns (navy, header only) · Total · Comments
- **Month bucketing**: bills issued before the 15th attribute to the
  *previous* month, on/after the 15th to the *current* month
- **Year-total** columns auto-inserted at year boundaries (`Dec-23 → 2023 → Jan-24`)
- **Total** column = `SUM(...)` over month columns only (skips year totals)
- **Heavy outer border** around each table block; inner thin borders kept
- **Two empty white rows** above the first table's green header
- **Two empty white rows** between the green header and the scraped-date
  sub-header
- **Property + Address** at top-left, soft grey borders, bold + italic + underlined
- Pre-export bank-style **merge dialog** when OCR variants of provider /
  property / account / address are detected

### Auto-extract setup mode (new — key-anchored)
The old guided auto-search (Tick / Skip / Right / Below cycle) is gone.
Replaced by a **drawing-based** flow:

1. User clicks the magic-wand → "auto-extract setup" mode
2. User draws **VALUE** box → field-label picker → field saved
3. User draws **KEY** box → no picker → key attached to last value
4. User clicks **Apply to all pages** or **Apply to all open PDFs**
5. Engine reads each key's text, computes `valueBbox − keyBbox` offset,
   then for each target page/PDF: searches for the key text and places
   a value-only highlight at `keyMatch + offset`

Implementation lives in [PDFViewer.tsx](../src/components/PDFViewer.tsx) (`autoSetupActive`,
`autoPairs`, `resolveAutoPairs`, `handleAutoApplyAllPages`,
`handleAutoApplyAllPdfs`). Apply-to-all-PDFs delegates to Index.tsx via
the `onAutoApplyAllPdfs` prop so it can iterate other sessions.

**Fallback chain** for both directions:
- *Read source key text*: pdfjs `getTextAtRect` → backend `/extract-regions` with `strict:true`
- *Find key on target*: pdfjs `findTextPositionInPdf` → backend `/search` (exact → partial → fuzzy)

Cached per-key on each target so each unique key text triggers at most
one backend search round-trip.

### "Selected & Apply" popover
Click the `ListChecks` icon in the toolbar → popover with every
highlight in the active PDF, color dot + field label + page number,
checkboxes, **Select all** / **Clear**. Three apply buttons inside:
- Apply to all pages
- Apply to all open PDFs
- Apply to N selected PDFs (only if ≥1 tab is multi-selected)

If nothing is checked, the action falls through to "all". If a subset
is checked, the existing "all" highlights on each target are preserved
(append, not replace).

### Vector-only PDF support — client-side rasterization
Some PDFs (Panorama / Oakbrook rent rolls) contain only vector path
drawings — no text layer, no images. The backend can't OCR them.
**No backend change needed** because the frontend handles it:

[`src/lib/vector-pdf-rasterizer.ts`](../src/lib/vector-pdf-rasterizer.ts):
- `classifyPdf(file)` → per-page `'text' | 'image' | 'vector' | 'empty' | 'mixed'`
- `isVectorOnlyPdf(file)` boolean shortcut
- `rasterizeVectorPdf(file, dpi=200, onProgress?)` → pdfjs renders each page to PNG, pdf-lib repackages
- `rasterizeIfVectorOnly(file, opts)` → drop-in pre-step; returns rasterized File only when needed

Wired into the upload loop in [Index.tsx](../src/pages/Index.tsx) so the
backend never sees a vector PDF — it gets a normal image-PDF and its
existing image-OCR path handles it.

### Other notable frontend details
- **Search bar** (Ctrl+F) cascades exact → partial → fuzzy on the
  backend, then falls back to client-side pdfjs substring search
- **Tab handling**: drag-reorder, Ctrl/Cmd-click multi-select, Shift-click
  range select, Ctrl+Tab to cycle (where Chrome lets us preventDefault)
- **PageUp / PageDown** navigates PDF pages
- **Highlight clipboard**: copy/paste highlights between pages
- **Auto-recovery**: if backend says session expired (404), frontend
  re-uploads the original File and retries with the new session_id
- **Sessions cache**: open PDFs survive `/admin` round-trips (lives in
  [`src/lib/sessions-cache.ts`](../src/lib/sessions-cache.ts), not localStorage — File blobs can't serialize)

---

## 3. Backend

The backend is **separate from this repo** (lives at
`pexlbackend.bulkscraper.cloud`, FastAPI). The frontend assumes:

### Endpoints used

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/utility/process` | upload PDF or DOCX → returns `{session_id, total_pages, pages: [{page_number, is_ocr, char_count, status}], ...}`. For DOCX, also serves the converted PDF at `/session/{id}/pdf`. |
| `POST` | `/api/utility/extract-regions` | body: `{session_id, strict?, highlights: [{page, field, x, y, width, height}]}` → `{results: [{page, field, value, confidence, wasOcr}]}`. `strict:true` disables backend smart-detection (used by normal Extract + auto-extract). |
| `POST` | `/api/utility/search` | body: `{session_id, query, mode, fuzzy_threshold?, limit?}` where `mode ∈ {exact, partial, fuzzy}` → `{query, mode, count, page_sizes: {[page]: {width,height}}, results: [{page, text, score, boxes}]}`. Used by Ctrl+F and as fallback for auto-extract apply. |
| `GET`  | `/api/utility/session/{id}/pdf` | converted-from-DOCX PDF, or original. |
| `GET`  | `/api/utility/session/{id}/ocr-pdf` | OCR'd searchable PDF for download / batch ZIP. |
| `GET`  | `/api/utility/health` or `/providers` | online check. |
| `POST` | `/pexl/usage` | body: `{files_processed, statements_extracted, downloads, doc_types: string[]}` → `{ok}`. |
| `GET`  | `/pexl/usage` | current user's totals. |
| `GET`  | `/pexl/admin/usage` | per-row history. New rows must include `doc_types: string[] | null`. |

### Backend stack (assumed)
- FastAPI + SQLAlchemy
- **PaddleOCR** (3.x — uses `predict()` API)
- **PyMuPDF (fitz)** for PDF parsing
- **Whoosh + RapidFuzz** for the search index
- **LibreOffice** (`soffice`) for DOCX → PDF conversion

### What the backend already does well
- Native-text PDFs → fast `page.get_text()` extraction
- Image-only / scanned PDFs → PaddleOCR pipeline
- DOCX uploads → LibreOffice converts to PDF → same pipeline
- Session-based caching of OCR'd documents
- Whoosh-powered fuzzy search across the whole document

### Backend gaps to close

1. **Vector-only PDFs** — fixed on the **frontend** by client-side
   rasterization. No backend change required. If you ever want to move
   it server-side, [`docs/backend_vector_pdf_fix.py`](backend_vector_pdf_fix.py)
   is a drop-in module: `text_for_page(page, ocr)`, `text_in_rect(...)`,
   `search_page_for(...)`. Detects vector pages, rasterizes at 200 DPI,
   feeds through PaddleOCR. Compatible with both 2.x and 3.x APIs.

2. **doc_types in usage** — the frontend now POSTs `doc_types: string[]`
   on every `/pexl/usage` call. Add the column to `Usage` and include
   it in `/pexl/admin/usage` response so the dashboard can render the
   per-type pills. Schema in `docs/PROMPT.md` § "Endpoints used".

### Recommended backend patch order
1. Add `doc_types: list[str]` to `TrackUsageRequest` and the Usage model
   (column or JSON). Include in `UsageOut` schema.
2. Verify `strict: true` is honored in `/extract-regions` — frontend
   sends it for the normal Extract button + auto-extract.
3. Optionally apply `backend_vector_pdf_fix.py` to make rasterization
   server-side (lighter network payloads).

---

## 4. File map

```
docs/
├── PROMPT.md                     ← this file
└── backend_vector_pdf_fix.py     ← optional server-side vector fix

src/
├── pages/
│   ├── Index.tsx                 ← main app shell
│   ├── Admin.tsx                 ← usage dashboard
│   ├── Login.tsx
│   └── AutoMap.tsx               ← Excel-template auto-mapper (separate flow)
├── components/
│   ├── PDFViewer.tsx             ← rendering, drawing, auto-extract setup
│   ├── ViewerToolbar.tsx         ← toolbar + Selected-Apply popover
│   ├── ExcelPanel.tsx            ← live extraction table
│   ├── HighlightOverlay.tsx
│   ├── HighlightLegend.tsx
│   ├── FieldLabelPicker.tsx
│   ├── UploadZone.tsx
│   ├── UtilityMergeDialog.tsx    ← (UNUSED, kept on disk)
│   ├── AutoHighlightDialog.tsx   ← (UNUSED — old auto-search dialog)
│   ├── PDFCardList.tsx
│   ├── ProcessingModal.tsx
│   ├── ThemeToggle.tsx
│   └── bank/MergeDialog.tsx      ← bank-style OCR-variant merge dialog
├── lib/
│   ├── api.ts                    ← /process, /extract-regions, /search wrappers
│   ├── pdf-extract.ts            ← pdfjs helpers (rect → text, text → bbox)
│   ├── excel-export.ts           ← xlsx-js-style writer (utility / appraisal / tax / lease)
│   ├── bank-excel-export.ts      ← ExcelJS writer (bank: roll-up + formulas)
│   ├── vector-pdf-rasterizer.ts  ← client-side vector→image-PDF conversion
│   ├── sessions-cache.ts         ← module-level cache so /admin doesn't drop sessions
│   └── field-label-synonyms.ts   ← (UNUSED — kept; auto-search relied on it)
├── contexts/
│   └── AuthContext.tsx
├── types/
│   └── utilscraper.ts            ← DocumentType, FieldLabel, FIELD_LABELS, …
└── App.tsx                       ← BrowserRouter + ProtectedRoute / AdminRoute
```

---

## 5. Common workflows

### A. Run locally
```bash
npm install
npm run dev          # vite dev server, default :5173
# Backend env:
echo "VITE_BACKEND_URL=https://pexlbackend.bulkscraper.cloud" > .env.local
```

### B. Type-check
```bash
npx tsc --noEmit -p tsconfig.app.json
```

### C. Test vector-PDF flow
1. Upload `public/docs/Panorama RR 042326.pdf` (vector-only).
2. Watch for the toast `📄 Rasterized vector PDF "X" for OCR`.
3. PDF opens in viewer; backend OCRs the rasterized version normally.
4. Draw highlights, Extract, Excel.

### D. Use the auto-extract feature
1. Click magic-wand → setup banner appears.
2. Draw VALUE box → label it (e.g. `billing_date`).
3. Draw KEY box (right next to / above the value, on the same page).
4. Repeat for more fields.
5. Click **Apply to all pages** or **Apply to all open PDFs**.

### E. Cherry-pick highlights for apply
1. Click the `ListChecks` toolbar button.
2. Tick the highlights you want.
3. Pick destination: all pages / all open PDFs / N selected PDFs.

---

## 6. Known fragile / open items

- **Auto-extract setup** placement uses absolute `valueBbox − keyBbox`
  offsets. Fine on uniform multi-page PDFs (rent rolls, monthly
  statements). Will misalign if the target's layout has shifted relative
  to the source.
- **Search bar Ctrl+Tab** — Chrome reserves this in some contexts. If
  you need bullet-proof PDF-tab cycling, consider F2/F3 or
  `Alt+ArrowLeft`/`Alt+ArrowRight`.
- **Sessions cache** survives route changes but **not** a hard refresh.
  File blobs can't serialize to localStorage. If you want refresh
  durability, you'd need to re-upload from a server-stored copy.
- **Old auto-search code paths** (`AutoHighlightDialog`, the synonym
  cycling banner, Tick/Skip/Right/Below) have been removed but the
  files (`AutoHighlightDialog.tsx`, `field-label-synonyms.ts`) are
  still on disk as dead code. Safe to delete.
- **PaddleOCR 2.x → 3.x migration** — the included
  `backend_vector_pdf_fix.py` works on both, but if you update
  PaddleOCR on the backend, smoke-test the OCR result shape.
- **Bank statement merge** runs OCR-similar provider/account/address
  detection. Utility merge runs the same scan but with looser rules
  (always show options for all fields with 2+ distinct values).

---

## 7. Continuation prompts for an LLM

If you start a fresh agent on this codebase, paste this section first:

> You're working in a React 18 + TypeScript + Vite app called Pexl
> that scrapes structured fields from PDFs. The frontend talks to a
> separate FastAPI backend at `pexlbackend.bulkscraper.cloud`. Read
> `docs/PROMPT.md` for the full architecture overview before making
> any changes. Key constraints:
>
> - Don't change the backend without asking — most issues can be
>   fixed client-side.
> - Existing flows (Extract, Apply-to-all-pages, Apply-to-all-PDFs,
>   Search, Excel export) must keep working unchanged when adding new
>   features.
> - Cell types in Excel export must match the snap-format sets in
>   `src/lib/api.ts` exactly.
> - The auto-extract setup mode is the new one (key + value drawing).
>   The old auto-search dialog is gone.
> - Vector-only PDFs go through `rasterizeIfVectorOnly` in the upload
>   loop — don't bypass it.

For backend dev handoff, paste § 3 ("Backend") plus this:

> The frontend already handles vector PDFs client-side. Your only
> required backend changes:
>
> 1. Accept `doc_types: list[str]` on `POST /pexl/usage` and persist it.
> 2. Include `doc_types` in `GET /pexl/admin/usage` response rows.
> 3. Ensure `strict: true` in `/extract-regions` body disables any
>    label-adjacent smart detection — return only what's literally
>    inside each highlight rect.
>
> The optional `backend_vector_pdf_fix.py` is a drop-in module if you
> ever want to move vector-PDF rasterization server-side. It supports
> both PaddleOCR 2.x and 3.x.
