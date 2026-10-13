# FinAi → Pexl → Excel

FinAi scrapes and processes data, uploads its value-only `.xlsx` to Pexl,
and selects one or more uploaded Excel templates. Pexl maps source columns
into those templates and returns download paths. FinAi downloads the outputs
and can forward the bytes to BossPDF or other apps using their APIs.

This implements the Pexl side. It does not change FinAi or BossPDF, push
callbacks, or reuse browser-local template state. Upload the template files
through this API once, then reuse their IDs.

For Pexl's own document types (Utility Bill, Bank Statement, Appraisal, Lease
Contract, Tax, Others) FinAi doesn't need a template: it sends the extracted
values and the type to `POST /api/v1/exports`, and Pexl returns the workbook
its Export button produces. See [Export by document type](#export-by-document-type).

## Run

Python 3.10+; from the repository root:

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r backend/requirements-integration.txt
# Store the generated key securely and give the same key to FinAi.
$finaiKey = .\.venv\Scripts\python -c "import secrets; print(secrets.token_urlsafe(32))"
$env:PEXL_API_KEYS = @{finai=$finaiKey} | ConvertTo-Json -Compress
.\.venv\Scripts\python -m uvicorn integration_api:app --app-dir backend --host 127.0.0.1 --port 8000
```

Swagger UI: `http://127.0.0.1:8000/docs`; OpenAPI: `/openapi.json`.
The existing `main:app` also mounts these routes when using the full OCR backend.
No MCP dependency is needed to import the HTTP router.

`PEXL_API_KEYS` is a JSON object mapping client names to distinct secret strings
of at least 32 characters. Missing/invalid configuration disables the routes
with 503. All integration routes require `Authorization: Bearer <key>`;
artifacts are scoped to the corresponding client name. Keep keys on backend
servers, use HTTPS when exposing the service, and apply proxy request limits.
This authentication covers the new `/api/v1` routes only.

`PEXL_INTEGRATION_DIR` optionally chooses the persistent storage directory;
default: `backend/integration-data`. SQLite stores both metadata and workbook
bytes atomically. Back up this directory and provision disk space. There is
currently no automatic retention cleanup. Use a persistent local disk on one
host; this is not a distributed job queue.

## HTTP contract

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/v1/files/source` | Multipart `file`: FinAi source workbook |
| POST | `/api/v1/files/template` | Multipart `file`: destination template |
| GET | `/api/v1/files/{kind}/{id}?sheet=Sheet1&header_row=1` | Inspect headers (`kind`: source/template) |
| POST | `/api/v1/jobs` | Fill one or more templates synchronously |
| GET | `/api/v1/jobs/{id}` | Retrieve a completed job |
| GET | `/api/v1/outputs/{id}` | Download authenticated Excel bytes |
| GET | `/api/v1/doc-types` | Pexl document types and their field keys |
| POST | `/api/v1/exports` | Build a doc-type workbook from extracted values |

Upload responses contain `id`, `filename`, and worksheet names/dimensions.
Jobs complete within the request and return 201 with `status: completed`.
Validation errors return 422; oversized files return 413; invalid credentials
return 401; missing or another client's IDs return 404. Failed validation
persists no job or outputs. Retrying POST creates a new job (no idempotency key).

Example request:

```json
{
  "source_id": "ID_FROM_SOURCE_UPLOAD",
  "external_reference": "finai-run-123",
  "outputs": [
    {
      "template_id": "ID_FROM_TEMPLATE_UPLOAD",
      "source_sheet": "Processed",
      "template_sheet": "Report",
      "source_header_row": 1,
      "template_header_row": 1,
      "start_row": 2,
      "mapping": {
        "Customer": "customer_name",
        "Balance": "processed_balance"
      }
    }
  ]
}
```

Mapping direction is **destination header → source header**, exact and
case-sensitive. Rows/positions are 1-based. Add output entries for additional
templates; the same source can also supply different sheets to different
outputs. Each output includes `id`, `filename`, `rows_written`, and a relative
`download_path`; send the same bearer token when downloading.

Supported: `.xlsx`, up to 20 MiB compressed, 100 MiB expanded, 250,000 worksheet
cells per input workbook, and ten outputs per job. Mapping writes consecutive
rows starting at `start_row`, skipping rows empty across all mapped columns.
Existing mapped values in this range are replaced. Unmapped cells/sheets are
retained; mapped template formulas and merged cells are rejected. Styles in
the starting row are copied to new unstyled cells. Dates and numbers remain
typed values; source formula cells must be converted to values by FinAi.
Pexl does not evaluate formulas, extend template formulas, resize Excel tables,
or clear template data below the rows written. Use a clean template with enough
preconfigured formulas when needed. Advanced Excel features may not survive
an openpyxl round trip; validate representative production templates.

## Export by document type

Builds the workbook Pexl's Export button makes for a document type: the same
sheets, month bucketing, merges, fills, borders and formulas. There's no
template upload and no column mapping. Templates (`/files`, `/jobs`) stay
available for custom layouts.

### `GET /api/v1/doc-types`

Lists Pexl's document types and the field keys each layout uses. Check
FinAi's type and field names against this list instead of hard-coding them.

```json
[
  {
    "value": "utility_bill",
    "label": "Utility Bill",
    "fields": [
      { "value": "provider_name", "label": "Provider Name" },
      { "value": "billing_date", "label": "Billing Date" },
      { "value": "total_electricity_bill", "label": "Total Electricity" }
    ]
  },
  { "value": "others", "label": "Others", "fields": [] }
]
```

(The real response lists every field. `others` is free-form: any field name
becomes a column.)

### `POST /api/v1/exports`

```json
{
  "doc_type": "utility_bill",
  "external_reference": "finai-run-123",
  "options": { "date_field": "auto" },
  "files": [
    {
      "filename": "bill.pdf",
      "folder_name": "",
      "rows": [
        { "page": 1, "field": "provider_name", "value": "ConEd" },
        { "page": 1, "field": "total_electricity_bill", "value": "41.32" },
        { "page": 1, "field": "billing_date", "value": "09/18/2026" }
      ]
    }
  ]
}
```

Response `201`:

```json
{
  "id": "4f6c…",
  "doc_type": "utility_bill",
  "filename": "Pexl_UtilityRecon_2026-10-13-09-30.xlsx",
  "download_path": "/api/v1/outputs/4f6c…",
  "created_at": "2026-10-13T09:30:12.345678+00:00",
  "external_reference": "finai-run-123",
  "unknown_fields": []
}
```

Download the workbook from `download_path` with the same bearer token, as for
job outputs.

**Request fields**

- `doc_type`: a `value` from `/api/v1/doc-types`.
- `rows`: Pexl's extracted-row shape. `page` is 1-based. `field` is Pexl's
  field key. `value` is the text Pexl would hold; numbers are accepted and
  converted to text, and `null` or `""` means no value. `confidence`
  (`high`/`medium`/`low`, default `high`) and `wasOcr` (default `false`)
  are optional.
- `files`: one entry per source document. Each file is kept separate, as one
  uploaded PDF is in the browser. `folder_name` fills the Folder columns.
- `options.date_field` (utility bills only) picks the field that decides a
  bill's month column:
  - `billing_date`: a bill dated before the 15th rolls back to the previous
    month.
  - `date`: the month named on the date.
  - `auto` (default): `billing_date` if any row has one, otherwise `date`.
- `external_reference`: echoed back, and used (sanitised) as the filename
  stem where the layout names files after the batch.

**Response notes**

- `unknown_fields` lists keys the chosen type's layout doesn't know, such as
  a typo or another type's field. Their values still appear in the
  Plain Data sheet, as in the browser, but get no column in the templated
  sheet. `<field>_expr` (a utility amount's source arithmetic, e.g. `1.2+2.3`)
  isn't reported.
- Send dates as `MM/DD/YYYY`. Other formats are parsed by JavaScript in the
  server's timezone, which can differ from a browser user's.

**Errors**

| Status | When |
| --- | --- |
| 401 | Missing or wrong bearer key |
| 404 | Downloading another client's output |
| 413 | More than 1,000 files or 100,000 rows in total |
| 422 | Unknown `doc_type` or `date_field`, or malformed `files`/`rows`. The `detail` names the problem |
| 503 | API keys not configured, or the Node export runtime is missing or timed out (120 s) |

### How the server builds it

There is one implementation of each layout: the TypeScript exporters in
`src/lib/` (`excel-export.ts`, `utility-excel-export.ts`,
`bank-excel-export.ts`). `buildExportWorkbook()` returns the workbook bytes.
The browser saves them, and the server returns them to FinAi.
`src/server/export-cli.ts` wraps it as a command, and
`npm run build:export` bundles that to `dist-server/export-workbook.mjs`.
For each export, the Python API validates the request, runs
`node dist-server/export-workbook.mjs build`, and stores the result like any
job output.

### Deployment

- Node.js 18+ must be on the backend host. It already is wherever
  `deploy.sh` builds the frontend. The bundle loads `exceljs` and `jszip` from
  the repo's `node_modules`, so run `npm install` first.
- `deploy.sh` runs `npm run build:export` after the frontend build. If you
  deploy by hand, run it after every pull that touches `src/lib/*export*`,
  `src/types/utilscraper.ts` or `src/server/`. `/doc-types` reloads when the
  bundle changes, so no restart is needed.
- Optional environment variables, for example in `backend/ecosystem.config.cjs`:
  - `PEXL_NODE_BIN`: path to `node`, if PM2's `PATH` lacks it.
  - `PEXL_EXPORT_SCRIPT`: bundle location. The default is
    `<repo>/dist-server/export-workbook.mjs`.
- nginx needs no change. Requests go through the existing backend proxy,
  whose `client_max_body_size` (250M) and `proxy_read_timeout` (900s)
  already cover export requests.

Locally:

```powershell
npm install
npm run build:export
.\.venv\Scripts\python -m uvicorn integration_api:app --app-dir backend --host 127.0.0.1 --port 8000
```

## FinAi client

Runnable example: `backend/examples/finai_client.py`. Set `PEXL_API_KEY` and
optionally `PEXL_API_URL`, then pass source/template paths, sheet names and
a JSON file containing the destination-to-source column mapping:

```powershell
python backend/examples/finai_client.py processed.xlsx template.xlsx Processed Report mapping.json output.xlsx
```

The example returns Excel bytes to FinAi's filesystem. FinAi can upload that
file to another app using that app's authenticated upload endpoint.

## MCP bridge

Uses the official [MCP Python SDK v1](https://py.sdk.modelcontextprotocol.io/v1/)
with stdio transport. FinAi's MCP host starts this process; the bridge calls
the HTTP service using FinAi's API key. The HTTP service must be running.

```json
{
  "mcpServers": {
    "pexl": {
      "command": "ABSOLUTE_PATH_TO_PYTHON",
      "args": ["ABSOLUTE_PATH_TO_REPO/backend/mcp_server.py"],
      "env": {
        "PEXL_API_URL": "http://127.0.0.1:8000",
        "PEXL_API_KEY": "YOUR_FINAI_KEY"
      }
    }
  }
}
```

Tools: `upload_workbook`, `inspect_workbook`, `fill_templates`, `get_job`,
`download_output`. Upload/download tools use base64, without local filesystem
access. Prefer HTTP transfers for large files to avoid sending large base64
payloads through an AI context. `fill_templates` accepts `job` matching the
HTTP job schema above. No remote MCP HTTP listener is started.

## Tests

```powershell
npm run build:export          # export tests build it if missing
python -m unittest discover -s backend -p "test_*.py"
npm test                      # vitest, incl. src/test/export-api-parity.test.ts
```

`backend/test_exports.py` posts each fixture in
`src/test/fixtures/export-requests.json` (one per doc type) through the API.
It compares the downloaded workbook with the browser builder's output for the
same rows: sheet names, values, formulas, merges and cell styles. The vitest
suite runs the same comparison in-process and checks utility month bucketing
for each `date_field` mode.
