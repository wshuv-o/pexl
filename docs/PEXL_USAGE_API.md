# Pexl → Odin usage contract

Pexl reports per-user activity to odin-ems, not to its own backend:

| Verb | URL                                    | Who calls it                          |
|------|----------------------------------------|---------------------------------------|
| POST | `{VITE_ODIN_API_URL}/pexl/usage`       | every tracker in `src/contexts/AuthContext.tsx` |
| GET  | `{VITE_ODIN_API_URL}/pexl/usage`       | `apiFetchUsage()` — the signed-in user's totals |
| GET  | `{VITE_ODIN_API_URL}/pexl/usage/all`   | `src/pages/Usage.tsx` — all users, one row per event |

All three carry `Authorization: Bearer <auth_token>`.

## POST body

```jsonc
{
  "files_processed":      2,          // PDFs handled in this event
  "statements_extracted": 37,         // values pulled out
  "downloads":            0,          // Excel downloads
  "ocr_downloads":        0,          // OCR'd-PDF downloads
  "table_extracts":       0,          // table exports
  "pages_extracted":      5,          // NEW — pages we did work on (see below)
  "doc_types":            ["appraisal", "utility_bill"],
  "uploaded_at":          "2026-08-19T09:12:44.001Z",   // optional
  "finished_at":          "2026-08-19T09:13:10.442Z"
}
```

Counters absent from a body mean "no change" — trackers only send what their
flow touched. `pages_extracted` is **omitted entirely when it would be 0**, so
an odin-ems build that predates the column keeps working unchanged.

## `pages_extracted`

Pages Pexl actually **did work on**, never the page count of the uploaded
document. A 40-page appraisal with highlight boxes on 3 pages reports `3`.
Definition per flow:

| Flow | UI entry point | Pages reported |
|------|----------------|----------------|
| Batch extract | Dashboard → *Extract* | distinct pages carrying ≥1 highlight, summed over the files the run got through (a stopped run reports only what finished) |
| OCR download | Viewer → *Download OCR PDF* | pages the backend OCR'd, read from the `ocr_progress` poll (falls back to the document's page count) |
| Table region export | Viewer table panel → *Export Excel* | `1` — a region lives on one page |
| Table Scrape | *Scrape all pages* | `page_count` — the calibrated lines run over every page |
| Crime Scrape | *Scrape folder → download Excel* | `X-Crime-Images` − `X-Crime-Errors` — one screenshot is one page here |

Pages are counted at the **scrape**, never again at the download or export.
Table Scrape's *Excel (all pages)* re-walks the whole PDF server-side but
reports nothing, so scraping a 20-page PDF and then exporting it records 20
pages, not 40.

Not reported: **Utility Import** (Excel rows → DB, no pages exist),
**Images → PDF** and **Auto-Map**, which have no usage tracking of any kind
yet.

## odin-ems side

Needs an integer column `pages_extracted` (default `0`, not null) on the pexl
usage table, accepted on POST and returned by both GETs. Until it exists the
field is silently dropped and the dashboard's *Pages extracted* card reads 0 —
nothing else breaks.
