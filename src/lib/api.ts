/* eslint-disable @typescript-eslint/no-explicit-any */
import type { PageInfo, Highlight, ExtractedRow, OcrProgress } from '@/types/utilscraper';
import { extractFromRegions } from './pdf-extract';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000' ;

// Strip emoji, dingbats, decorative symbols, hidden binary strings, and
// e-signature platform artifacts (DocuSign, Adobe Sign, etc.) from extracted text.
function sanitizeValue(val: string | null | undefined): string | null {
  if (!val) return val ?? null;
  const cleaned = val
    // DocuSign / Adobe Sign placeholder tags: [text|req|signer1 ...], [sig|req|signer2], etc.
    .replace(/\[(?:text|sig|date|initial|checkbox|radio|attachment|note)[^\]]*\]/gi, '')
    // "Doc ID: <hash>" footers injected on every page by DocuSign
    .replace(/\bDoc(?:ument)?\s*ID\s*:\s*\S+/gi, '')
    // Generic e-sig annotation brackets that survived (any remaining [word|...] pattern)
    .replace(/\[[a-z]+\|[^\]]{0,120}\]/gi, '')
    .replace(/[^\p{L}\p{N}\p{P}\p{Z}\p{Sc}\p{Sm}]/gu, '')
    .replace(/\b[01]{8,}\b/g, '')       // strip binary-encoded hidden numbers (8+ digits of only 0/1)
    .replace(/\s+/g, ' ')
    .trim();
  // Deduplicate exact doubled strings: "3450 3450" → "3450", "Hello Hello" → "Hello".
  // Caused by image + text layer both being extracted for the same region.
  const deduped = (() => {
    if (cleaned.length < 2) return cleaned;
    // Word-level dedup (with space separator)
    const spaceHalf = Math.floor(cleaned.length / 2);
    if (cleaned.length % 2 === 1) {
      // odd length — check if there's a space in the middle
      const mid = (cleaned.length - 1) / 2;
      if (cleaned[mid] === ' ') {
        const a = cleaned.slice(0, mid);
        const b = cleaned.slice(mid + 1);
        if (a === b) return a;
      }
    } else {
      const a = cleaned.slice(0, spaceHalf);
      const b = cleaned.slice(spaceHalf);
      if (a === b) return a;
      // also check with space separator at midpoint
      if (cleaned[spaceHalf] === ' ') {
        const a2 = cleaned.slice(0, spaceHalf);
        const b2 = cleaned.slice(spaceHalf + 1);
        if (a2 === b2) return a2;
      }
    }
    return cleaned;
  })();
  return deduped || null;
}

const MONTH_MAP: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7,
  aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function normalizeDateValue(raw: string): string {
  let s = raw;

  // --- Strip an arbitrary "<label>:" prefix that OCR glued onto the value
  // (e.g. "Thisstatement:December 15 2025" → "December 15 2025"). Matches
  // the backend's _strip_inline_label so dates are normalized consistently
  // whether the value came from /api/utility/extract-regions (server) or
  // from the client-side pdfjs fallback (which has no normalization).
  //
  // Only the leftmost colon NOT preceded by a digit is considered (skips
  // time patterns like "12:30 PM"). Only strip if what comes after the
  // colon actually looks date-ish; otherwise leave the value alone.
  {
    const colonMatch = s.match(/(?<!\d):\s*/);
    if (colonMatch && colonMatch.index !== undefined) {
      const rest = s.slice(colonMatch.index + colonMatch[0].length).trim();
      const looksDateish =
        /(?:19|20)\d{2}/.test(rest) ||
        /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\b/i.test(rest) ||
        /\b\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}\b/.test(rest);
      if (rest && looksDateish) s = rest;
    }
  }

  // --- OCR digit/letter fixes ---
  s = s.replace(/\bIst\b/gi, '1st');
  s = s.replace(/\bI(\d)/g, '1$1');        // "I5" → "15"
  s = s.replace(/(\d)I\b/g, '$11');         // "2I" → "21"
  s = s.replace(/\bl(\d)/g, '1$1');         // "l5" → "15"  (lowercase L)
  s = s.replace(/(\d)l/g, '$11');           // "2l" → "21"
  s = s.replace(/\bO(\d)/g, '0$1');         // "O5" → "05"
  s = s.replace(/(\d)O/g, '$10');           // "3O" → "30"

  // --- Remove stray dots (keep single dot in numeric dates like 01.15.2025) ---
  s = s.replace(/\.{2,}/g, ' ');            // ".." or "..." → space
  s = s.replace(/(?<=[a-zA-Z])\.(?=[a-zA-Z])/g, ' '); // dot between letters → space

  // --- Insert missing spaces between letters and digits ---
  s = s.replace(/([a-zA-Z])(\d)/g, '$1 $2');   // "September2025" → "September 2025"
  s = s.replace(/(\d)([a-zA-Z])/g, '$1 $2');   // "15September"   → "15 September"

  // --- Strip ordinal suffixes ---
  s = s.replace(/(\d+)\s*(?:st|nd|rd|th)\b/gi, '$1');

  // --- Strip filler words ---
  s = s.replace(/\bday\b/gi, '');
  s = s.replace(/\bof\b/gi, '');
  s = s.replace(/\bthe\b/gi, '');

  // --- Normalise whitespace ---
  s = s.replace(/[,]+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();

  // --- Numeric date with spaces around separators: "01 / 31 / 2026" or "1-31-2026" ---
  // DocuSign date fields often insert spaces around the slash separator.
  const numericSpaced = s.replace(/\s*[/-]\s*/g, '/').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (numericSpaced) {
    return `${numericSpaced[1].padStart(2, '0')}/${numericSpaced[2].padStart(2, '0')}/${numericSpaced[3]}`;
  }

  // --- Try to parse "D Month YYYY" or "Month D YYYY" ---
  const patA = s.match(/^(\d{1,2})\s+([a-zA-Z]+)\s+(\d{4})$/);
  if (patA) {
    const month = MONTH_MAP[patA[2].toLowerCase()];
    if (month) {
      const day = parseInt(patA[1], 10);
      return `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/${patA[3]}`;
    }
  }

  const patB = s.match(/^([a-zA-Z]+)\s+(\d{1,2})\s+(\d{4})$/);
  if (patB) {
    const month = MONTH_MAP[patB[1].toLowerCase()];
    if (month) {
      const day = parseInt(patB[2], 10);
      return `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/${patB[3]}`;
    }
  }

  const patC = s.match(/^([a-zA-Z]+)\s+(\d{4})$/);
  if (patC) {
    const month = MONTH_MAP[patC[1].toLowerCase()];
    if (month) {
      return `${String(month).padStart(2, '0')}/01/${patC[2]}`;
    }
  }

  return s;
}

const DATE_FIELDS = new Set([
  'billing_date', 'statement_date', 'appraised_date',
  'lease_date', 'lease_begin_date', 'lease_end_date',
  'tax_bill_date', 'tax_due_date',
]);

const AMOUNT_FIELDS = new Set([
  'total_gas_bill', 'total_electricity_bill', 'total_internet_bill',
  'total_phone_bill', 'total_water_bill', 'total_sewer_bill',
  'total_water_sewer_bill', 'total_trash_bill', 'total_utilities',
  'beginning_balance', 'ending_balance', 'total_credits', 'total_debits',
  'appraised_as_is_value',
  'security_deposit', 'rent_and_charges', 'monthly_rent',
  'onetime_concession_amount', 'monthly_discount', 'other_discount',
  'total_income_ca', 'total_income_non_ca', 'total_rent',
  'utility_allowance', 'ca_shelter_allowance', 'cityfheps_rent_supplement',
  'household_share', 'utility_payment', 'total_monthly_rent',
  'total_tax_due', 'assessed_value',
]);

// cap_rate arrives already-numeric — no percent conversion.
const PERCENT_FIELDS = new Set<string>();
const YEAR_FIELDS = new Set(['tax_year']);

function normalizePercentValue(raw: string): string {
  const s = raw.replace(/[^\d.-]/g, '').trim();
  const n = parseFloat(s);
  if (isNaN(n)) return raw;
  const pct = n > 0 && n < 1 ? n * 100 : n;
  return `${pct.toFixed(2)}%`;
}

function normalizeYearValue(raw: string): string {
  const m = raw.match(/(\d{4})/);
  return m ? m[1] : raw.trim();
}

function normalizeAmountValue(raw: string): string {
  let s = raw.replace(/[^0-9.,$-]/g, '').trim();
  s = s.replace(/[$,]/g, '');

  // OCR/text-layer duplication: "34503450" → "3450", "1234.561234.56" → "1234.56".
  // Happens when the image layer and the text layer both contain the same number
  // and both are picked up by the extractor.
  if (s.length >= 2 && s.length % 2 === 0) {
    const half = s.length / 2;
    if (s.slice(0, half) === s.slice(half)) s = s.slice(0, half);
  }

  const concatMatch = s.match(/^(-?\d+\.\d{2})(\d+\.\d{2})$/);
  if (concatMatch) s = concatMatch[1];

  const dotIdx = s.indexOf('.');
  if (dotIdx >= 0) {
    const beforeDot = s.slice(0, dotIdx);
    const afterDot = s.slice(dotIdx + 1);
    if (afterDot.length === 2 && beforeDot.length > 6) {
      const amounts = raw.match(/-?\$?[\d,]+\.\d{2}/g);
      if (amounts && amounts.length >= 1) {
        const first = amounts[0].replace(/[$,]/g, '');
        const num = parseFloat(first);
        if (!isNaN(num)) return num.toFixed(2);
      }
    }
  }

  const dotCount = (s.match(/\./g) || []).length;
  if (dotCount > 1) {
    const firstAmount = s.match(/^(-?\d+\.\d{2})/);
    if (firstAmount) {
      s = firstAmount[1];
    } else {
      const lastDot = s.lastIndexOf('.');
      s = s.slice(0, lastDot).replace(/\./g, '') + s.slice(lastDot);
    }
  }

  const num = parseFloat(s);
  if (isNaN(num)) return raw;
  return num.toFixed(2);
}

function sanitizeResults(results: ExtractedRow[]): ExtractedRow[] {
  return results.map(r => {
    const cleaned = sanitizeValue(r.value);
    if (!cleaned) return { ...r, value: cleaned };
    let v = cleaned;
    if (DATE_FIELDS.has(r.field))         v = normalizeDateValue(v);
    else if (AMOUNT_FIELDS.has(r.field))  v = normalizeAmountValue(v);
    else if (PERCENT_FIELDS.has(r.field)) v = normalizePercentValue(v);
    else if (YEAR_FIELDS.has(r.field))    v = normalizeYearValue(v);
    return { ...r, value: v };
  });
}

let backendOnline = false;

async function checkBackend(): Promise<boolean> {
  try {
    const res = await fetch(`${BACKEND_URL}/api/utility/health`, {
      signal: AbortSignal.timeout(2000),
    });
    backendOnline = res.ok;
  } catch {
    // Also try /providers as alias
    try {
      const res = await fetch(`${BACKEND_URL}/api/utility/providers`, {
        signal: AbortSignal.timeout(2000),
      });
      backendOnline = res.ok;
    } catch {
      backendOnline = false;
    }
  }
  return backendOnline;
}

// Check on load
checkBackend();

export function isBackendOnline() {
  return backendOnline;
}

const isWordFile = (f: File) =>
  f.type === 'application/msword'
  || f.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  || /\.docx?$/i.test(f.name);

export async function fetchConvertedPdf(sessionId: string, originalName: string): Promise<File | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/api/utility/session/${sessionId}/pdf`);
    if (!res.ok) return null;
    const blob = await res.blob();
    // Preserve the display name (strip any .doc/.docx suffix, append .pdf).
    const stem = originalName.replace(/\.(docx?|pdf)$/i, '');
    return new File([blob], `${stem || sessionId}.pdf`, { type: 'application/pdf' });
  } catch {
    return null;
  }
}

export type OcrFetchReason = 'ok' | 'server-error' | 'not-found' | 'network' | 'not-pdf' | 'unknown';

export interface OcrFetchResult {
  blob: Blob | null;
  reason: OcrFetchReason;
  status?: number;   // last HTTP status we saw
}

const TRANSIENT_STATUSES = new Set([502, 503, 504, 522, 524]);

export async function fetchOcrPdfBlob(sessionId: string): Promise<Blob | null> {
  const result = await fetchOcrPdfBlobWithReason(sessionId);
  return result.blob;
}

export async function fetchOcrPdfBlobWithReason(sessionId: string): Promise<OcrFetchResult> {
  const endpoints = [
    `${BACKEND_URL}/api/utility/session/${sessionId}/ocr-pdf`,
    `${BACKEND_URL}/api/utility/session/${sessionId}/pdf`,
  ];

  let lastStatus: number | undefined;
  let lastReason: OcrFetchReason = 'unknown';
  let skipRemainingEndpoints = false;

  for (const url of endpoints) {
    if (skipRemainingEndpoints) break;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // OCR on multi-page PDFs can easily exceed a minute, especially on
        // CPU-only Paddle with oneDNN disabled. 10 minutes is the upper bound
        // before we assume something is actually stuck.
        const res = await fetch(url, { signal: AbortSignal.timeout(600_000) });
        lastStatus = res.status;
        if (res.ok) {
          const b = await res.blob();
          if (b.size > 0 && b.type.includes('pdf')) {
            return { blob: b, reason: 'ok', status: res.status };
          }
          lastReason = 'not-pdf';
          break; // bad body, move to next endpoint
        }
        // Non-OK: retry on transient statuses, otherwise move on.
        if (TRANSIENT_STATUSES.has(res.status) && attempt === 0) {
          lastReason = 'server-error';
          await new Promise(r => setTimeout(r, 600));
          continue;
        }
        if (res.status === 404) { lastReason = 'not-found'; break; }
        if (res.status >= 500) {
          // Gateway/server dead — all three endpoints are on the same host
          // so trying the others is pointless noise.
          lastReason = 'server-error';
          skipRemainingEndpoints = true;
          break;
        }
        lastReason = 'unknown';
        break;
      } catch (err: unknown) {
        void err;
        lastReason = 'network';
        lastStatus = undefined;
        if (attempt === 0) {
          await new Promise(r => setTimeout(r, 600));
          continue;
        }
        skipRemainingEndpoints = true;
        break;
      }
    }
  }

  return { blob: null, reason: lastReason, status: lastStatus };
}

export async function fetchOcrPdfBlobWithRecovery(
  sessionId: string,
  file: File | undefined,
): Promise<OcrFetchResult & { newSessionId?: string }> {
  const first = await fetchOcrPdfBlobWithReason(sessionId);
  if (first.blob || first.reason !== 'not-found' || !file) return first;

  try {
    const form = new FormData();
    form.append('file', file);
    form.append('provider', '');
    const res = await fetch(`${BACKEND_URL}/api/utility/process`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) return first;
    const data = await res.json();
    const newId: string | undefined = data?.session_id;
    if (!newId) return first;

    const retry = await fetchOcrPdfBlobWithReason(newId);
    return { ...retry, newSessionId: newId };
  } catch {
    return first;
  }
}

// Turn a reason + status into a message the user can act on.
export function ocrFetchErrorMessage(result: OcrFetchResult, filename?: string): string {
  const name = filename ? ` for ${filename}` : '';
  switch (result.reason) {
    case 'server-error':
      return `Backend error${result.status ? ` (${result.status})` : ''}${name} — the server couldn't build the OCR'd PDF. Try again in a moment.`;
    case 'not-found':
      return `Session expired${name} — please re-upload the PDF and try again.`;
    case 'network':
      return `Network error${name} — check your connection or the backend may be offline.`;
    case 'not-pdf':
      return `Backend returned an unexpected response${name}. The OCR endpoint may not be deployed yet.`;
    default:
      return `OCR PDF not available${name}.`;
  }
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function downloadOcrPdf(
  sessionId: string,
  originalName: string,
  file?: File,
): Promise<{ newSessionId?: string; blob: Blob; filename: string }> {
  const result = await fetchOcrPdfBlobWithRecovery(sessionId, file);
  if (!result.blob) throw new Error(ocrFetchErrorMessage(result, originalName));
  const stem = originalName.replace(/\.(docx?|pdf)$/i, '') || sessionId;
  const filename = `${stem}_ocr.pdf`;
  triggerDownload(result.blob, filename);
  return { newSessionId: result.newSessionId, blob: result.blob, filename };
}

export async function fetchTableRegions(
  sessionId: string,
): Promise<Record<number, Array<{ x: number; y: number; width: number; height: number }>>> {
  try {
    const res = await fetch(`${BACKEND_URL}/api/utility/session/${sessionId}/tables`);
    if (!res.ok) return {};
    const data = await res.json();
    const out: Record<number, Array<{ x: number; y: number; width: number; height: number }>> = {};
    for (const [page, boxes] of Object.entries((data as { tables: Record<string, unknown[]> }).tables ?? {})) {
      out[parseInt(page)] = boxes as Array<{ x: number; y: number; width: number; height: number }>;
    }
    return out;
  } catch {
    return {};
  }
}

export async function downloadExcel(
  sessionId: string,
  originalName: string,
  pages?: string,
): Promise<void> {
  const url = new URL(`${BACKEND_URL}/api/utility/session/${sessionId}/excel`);
  if (pages?.trim()) url.searchParams.set('pages', pages.trim());
  const res = await fetch(url.toString());
  if (res.status === 404) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error ?? 'No tables found in this PDF');
  }
  if (!res.ok) {
    throw new Error(`Excel export failed (${res.status})`);
  }
  const blob = await res.blob();
  const stem = originalName.replace(/\.(docx?|pdf)$/i, '') || sessionId;
  triggerDownload(blob, `${stem}_tables.xlsx`);
}

export interface TableCell {
  row: number;
  col: number;
  rowspan: number;
  colspan: number;
  text: string;
}

export interface TableRegionResult {
  rows: string[][];
  ncols: number;
  source?: string;
  cells?: TableCell[];
}

// Helper: run `fetch` and treat both real 404s AND CORS/network failures
// (which fetch() throws instead of returning a response) as "session
// gone, try reupload". Some deployed backends CORS-block their own error
// responses so a 404 arrives at the client as a TypeError; without this
// wrapping the reupload path never fires and users see "session expired".
async function fetchWithReuploadRecovery(
  doFetch: (id: string) => Promise<Response>,
  sessionId: string,
  opts: { file?: File; onSessionRenewed?: (oldId: string, newId: string) => void },
): Promise<Response> {
  let res: Response | null = null;
  let threwNetworkError = false;
  try {
    res = await doFetch(sessionId);
  } catch {
    threwNetworkError = true;
  }

  const shouldRetry =
    !!opts.file &&
    (threwNetworkError || (res !== null && res.status === 404));

  if (shouldRetry) {
    const newId = await reprocessFile(opts.file!);
    if (newId) {
      opts.onSessionRenewed?.(sessionId, newId);
      try {
        res = await doFetch(newId);
      } catch (err) {
        throw new Error((err as Error)?.message ?? 'Network error after reupload');
      }
    }
  }

  if (!res) throw new Error('Network error — check the backend is reachable and CORS is configured');
  return res;
}

export async function extractTableRegion(
  sessionId: string,
  page: number,
  x: number, y: number, width: number, height: number,
  transposed = false,
  opts: { file?: File; onSessionRenewed?: (oldId: string, newId: string) => void } = {},
): Promise<TableRegionResult> {
  const body = JSON.stringify({ page, x, y, width, height, transposed });
  const doFetch = (id: string) => fetch(
    `${BACKEND_URL}/api/utility/session/${id}/extract-table-region`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
  );

  const res = await fetchWithReuploadRecovery(doFetch, sessionId, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any).error ?? `Extraction failed (${res.status})`);
  return data as TableRegionResult;
}

export async function downloadTableRegionExcel(
  sessionId: string,
  page: number,
  x: number, y: number, width: number, height: number,
  filename: string,
  rows?: string[][],
  opts: { file?: File; onSessionRenewed?: (oldId: string, newId: string) => void } = {},
): Promise<void> {
  const body = JSON.stringify({ page, x, y, width, height, ...(rows ? { rows } : {}) });
  const doFetch = (id: string) => fetch(
    `${BACKEND_URL}/api/utility/session/${id}/extract-table-region/excel`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
  );

  const res = await fetchWithReuploadRecovery(doFetch, sessionId, opts);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as any).error ?? `Export failed (${res.status})`);
  }
  const blob = await res.blob();
  triggerDownload(blob, filename);
}

export async function downloadAllOcrPdfsAsZip(
  sessions: { id: string; filename: string; file?: File }[],
): Promise<{ added: number; missing: string[]; renewed: { oldId: string; newId: string }[] }> {
  if (sessions.length === 0) return { added: 0, missing: [], renewed: [] };

  // Dynamic import keeps jszip out of the initial bundle
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  const missing: string[] = [];
  const renewed: { oldId: string; newId: string }[] = [];
  let added = 0;
  const usedNames = new Set<string>();

  // De-duplicate filenames (two uploads of the same name)
  const uniqueName = (stem: string): string => {
    let name = `${stem}_ocr.pdf`;
    let i = 2;
    while (usedNames.has(name)) name = `${stem}_ocr (${i++}).pdf`;
    usedNames.add(name);
    return name;
  };

  const results = await Promise.all(sessions.map(async s => {
    const r = await fetchOcrPdfBlobWithRecovery(s.id, s.file);
    return { session: s, ...r };
  }));

  const reasonCounts: Record<OcrFetchReason, number> = {
    ok: 0, 'server-error': 0, 'not-found': 0, network: 0, 'not-pdf': 0, unknown: 0,
  };

  for (const r of results) {
    reasonCounts[r.reason]++;
    if (r.newSessionId && r.newSessionId !== r.session.id) {
      renewed.push({ oldId: r.session.id, newId: r.newSessionId });
    }
    if (!r.blob) { missing.push(r.session.filename); continue; }
    const stem = r.session.filename.replace(/\.(docx?|pdf)$/i, '') || r.session.id;
    zip.file(uniqueName(stem), r.blob);
    added++;
  }

  if (added === 0) {
    // Pick the most common non-ok reason to surface
    const dominant = (['server-error', 'not-found', 'network', 'not-pdf', 'unknown'] as OcrFetchReason[])
      .find(r => reasonCounts[r] > 0) ?? 'unknown';
    throw new Error(ocrFetchErrorMessage({ blob: null, reason: dominant }));
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const zipBlob = await zip.generateAsync({ type: 'blob' });
  triggerDownload(zipBlob, `Pexl_OCR_PDFs_${stamp}.zip`);
  return { added, missing, renewed };
}

// Map backend conversion-error details to friendly user-facing messages.
const friendlyConversionError = (detail: string): string | null => {
  const d = (detail || '').toLowerCase();
  if (d.includes('libreoffice not installed') || d.includes('soffice: not found')) {
    return 'Document conversion is temporarily unavailable. Please try again in a minute or upload a PDF.';
  }
  if (d.includes('timed out') || d.includes('timeout')) {
    return 'The Word document took too long to convert. Try a smaller file or save it as PDF first.';
  }
  if (d.includes('libreoffice conversion failed') || d.includes('conversion failed')) {
    return 'Couldn\u2019t read that Word document. Try saving it as PDF and uploading that instead.';
  }
  return null;
};

export async function processFile(
  file: File,
  provider: string,
  onProgress: (step: number, detail?: string) => void,
): Promise<{ session_id: string; total_pages: number; pages: PageInfo[]; convertedPdf?: File }> {

  const wordDoc = isWordFile(file);

  // Try backend first
  try {
    const checked = await checkBackend();
    if (checked) {
      onProgress(0, wordDoc ? 'Uploading & converting Word document...' : 'Uploading PDF...');
      const formData = new FormData();
      formData.append('file', file);
      formData.append('provider', provider);

      const res = await fetch(`${BACKEND_URL}/api/utility/process`, {
        method: 'POST',
        body: formData,
      });

      if (res.ok) {
        const data = await res.json();

        let convertedPdf: File | undefined;
        const ocrCount = data.ocr_pages_count ?? 0;
        // Only fetch the server-rendered PDF when necessary:
        //   - Word docs always need it (no browser fallback)
        //   - Native PDFs with OCR pages benefit from the baked-in text layer
        //   - Native PDFs with 0 OCR pages: original file is identical, skip round-trip
        if (wordDoc || ocrCount > 0) {
          onProgress(2, wordDoc ? "Fetching converted PDF..." : `Fetching OCR PDF (${ocrCount} pages)...`);
          const pdf = await fetchConvertedPdf(data.session_id, file.name);
          if (pdf) {
            convertedPdf = pdf;
          } else if (wordDoc) {
            // Word docs have no browser-renderable fallback — this must succeed.
            throw new Error(
              "Backend accepted the Word document but did not expose the converted PDF. " +
              "Ask ops to implement GET /api/utility/session/{session_id}/pdf."
            );
          }
        }

        onProgress(3, `Ready — ${ocrCount} pages OCR`);
        return {
          session_id: data.session_id,
          total_pages: data.total_pages,
          pages: data.pages,
          convertedPdf,
        };
      }

      let detail = '';
      try {
        const body = await res.json();
        // FastAPI uses `detail`; legacy handlers use `error` or `message`.
        detail = body.detail || body.error || body.message || '';
      } catch { /* body may be empty or non-JSON */ }

      if (/only pdf/i.test(detail) && wordDoc) {
        throw new Error('The server hasn\u2019t shipped Word support yet. Save the document as PDF and try again, or ping your deployment team to redeploy the backend.');
      }
      if (res.status === 415) {
        throw new Error('That file type isn\u2019t supported. Upload a PDF or Word document.');
      }
      if (res.status === 400) {
        throw new Error(detail || 'The uploaded file appears to be empty.');
      }
      const friendly = friendlyConversionError(detail);
      if (friendly) throw new Error(friendly);
      throw new Error(`Server error (${res.status})${detail ? `: ${detail}` : ''}`);
    }
  } catch (err) {
    // Word files have no viable client-side fallback — surface the error.
    if (wordDoc) throw err;
    /* else: fall through to client-side pdfjs */
  }

  // Client-side fallback using pdfjs
  onProgress(0, 'Uploading PDF...');
  try {
    const { pdfjs } = await import('react-pdf');
    const arrayBuffer = await file.arrayBuffer();

    onProgress(1, 'Analysing pages...');
    const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
    const totalPages = pdf.numPages;
    const pages: PageInfo[] = [];

    for (let i = 1; i <= totalPages; i++) {
      onProgress(1, `Analysing page ${i} of ${totalPages}`);
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map((item: any) => item.str).join('');
      const charCount = text.length;
      const letterCount = (text.match(/[a-zA-Z]/g) || []).length;
      const isOcr = charCount < 50 || letterCount < 20;

      pages.push({
        page_number: i,
        is_ocr: isOcr,
        char_count: charCount,
        status: isOcr ? 'ocr' : 'native',
      });
    }

    const ocrCount = pages.filter(p => p.is_ocr).length;
    if (ocrCount > 0) {
      onProgress(2, `${ocrCount} pages may need OCR — backend recommended`);
      await delay(400);
    }

    onProgress(3, 'Ready (client-side mode)');
    return {
      session_id: `local-${Date.now()}`,
      total_pages: totalPages,
      pages,
    };
  } catch (err) {
    console.error('Client-side PDF processing failed:', err);
    throw new Error('Failed to process PDF. Please try a different file.');
  }
}

/**
 * Re-upload a file to the backend and return the new session_id.
 * Returns null on failure. Used by consumers that detect a stale session.
 */
// In-flight reupload dedupe. Keyed by File identity so two concurrent 404
// recoveries against the same file (e.g. a second table extract fired
// before React state has swapped in the renewed session id) share one
// upload instead of racing two. Cleared as soon as the shared promise
// settles — a genuine second eviction later will start a fresh upload.
const _reprocessInFlight = new WeakMap<File, Promise<string | null>>();

export async function reprocessFile(file: File): Promise<string | null> {
  const existing = _reprocessInFlight.get(file);
  if (existing) return existing;

  const p = (async (): Promise<string | null> => {
    try {
      const formData = new FormData();
      formData.append('file', file);
      const resp = await fetch(`${BACKEND_URL}/api/utility/process`, { method: 'POST', body: formData });
      if (resp.ok) {
        const data = await resp.json();
        return data.session_id as string;
      }
    } catch { /* ignore */ }
    return null;
  })().finally(() => {
    _reprocessInFlight.delete(file);
  });

  _reprocessInFlight.set(file, p);
  return p;
}

export async function extractRegions(
  sessionId: string,
  highlights: Highlight[],
  file?: File,
  opts: { strict?: boolean; onSessionRenewed?: (oldId: string, newId: string) => void } = {},
): Promise<ExtractedRow[]> {

  // Must have at least one highlight
  if (!highlights || highlights.length === 0) {
    return [];
  }

  // `strict` tells the backend to just read text inside the rect — no
  // label-adjacent smart detection.
  const strict = opts.strict === true;

  // Helper: POST highlights to the backend. Handles the 404-renewal reupload
  // once. Returns the parsed results array on success, `null` on failure.
  // Kept local so the client-first fast path and the legacy backend-first
  // path share the same 404-recovery logic.
  const postExtract = async (
    liveId: string,
    hls: Highlight[],
  ): Promise<{ liveId: string; results: ExtractedRow[] } | null> => {
    const doFetch = (id: string) => fetch(
      `${BACKEND_URL}/api/utility/extract-regions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: id,
          strict,
          highlights: hls.map(h => ({
            page: h.page, field: h.field,
            x: h.x, y: h.y, width: h.width, height: h.height,
          })),
        }),
      },
    );

    let res = await doFetch(liveId);
    if (res.status === 404 && file) {
      const newId = await reprocessFile(file);
      if (newId) {
        opts.onSessionRenewed?.(liveId, newId);
        liveId = newId;
        res = await doFetch(liveId);
      }
    }
    if (!res.ok) return null;
    const data = await res.json();
    return { liveId, results: sanitizeResults(data.results) };
  };

  // ── FAST PATH ─────────────────────────────────────────────────────────
  // Strict extraction + we have the file → try client-side (pdfjs text
  // layer) first. This is instant for native pages and avoids a network
  // round-trip per session. Any highlight that comes back with `value:
  // null` (either an OCR page or a native page where no text sat inside
  // the rectangle) is still sent to the backend — so backend accuracy is
  // fully preserved for anything the client couldn't answer.
  if (strict && file && backendOnline && !sessionId.startsWith('local-')) {
    try {
      const clientResults = await extractFromRegions(
        file,
        highlights.map(h => ({
          page: h.page, field: h.field,
          x: h.x, y: h.y, width: h.width, height: h.height,
        })),
      );

      // Indices where the client had no value — those need the backend.
      const missingIdx: number[] = [];
      for (let i = 0; i < clientResults.length; i++) {
        if (clientResults[i].value === null) missingIdx.push(i);
      }

      // Everything was found client-side → done, no backend call.
      if (missingIdx.length === 0) return clientResults;

      // Ask the backend for just the missing ones and merge into the
      // client-side result array in-place, preserving original order.
      const backendCall = await postExtract(
        sessionId,
        missingIdx.map(i => highlights[i]),
      );
      if (backendCall) {
        const merged = [...clientResults];
        missingIdx.forEach((origIdx, backendIdx) => {
          const br = backendCall.results[backendIdx];
          if (br) merged[origIdx] = br;
        });
        return merged;
      }

      // Backend call failed — return what we have. Nulls stay null,
      // which is the same accuracy as the old client-side-fallback path.
      return clientResults;
    } catch (err) {
      console.warn('Client-first extraction failed, falling back to backend-first:', err);
      // Fall through to the legacy path below.
    }
  }

  // ── LEGACY BACKEND-FIRST PATH ────────────────────────────────────────
  // Used for non-strict extraction (backend does label-adjacent smart
  // detection the client can't replicate) or when we don't have a File
  // blob to feed pdfjs.
  try {
    if (backendOnline && !sessionId.startsWith('local-')) {
      const backendCall = await postExtract(sessionId, highlights);
      if (backendCall) return backendCall.results;
    }
  } catch {
    /* fall through to client-side */
  }

  // Client-side fallback for when the backend is unreachable.
  if (file) {
    try {
      const clientResults = await extractFromRegions(
        file,
        highlights.map(h => ({
          page:   h.page,
          field:  h.field,
          x:      h.x,
          y:      h.y,
          width:  h.width,
          height: h.height,
        })),
      );
      return sanitizeResults(clientResults);
    } catch (err) {
      console.error('Client-side region extraction failed:', err);
    }
  }

  // Last resort fallback
  await delay(300);
  return highlights.map(h => ({
    page:       h.page,
    field:      h.field,
    value:      null,
    confidence: 'low' as const,
    wasOcr:     false,
  }));
}


function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function triggerForceOcr(
  sessionId: string,
  opts: { file?: File; onSessionRenewed?: (oldId: string, newId: string) => void } = {},
): Promise<{ total_pages: number; sessionId: string } | null> {
  const doFetch = (id: string) => fetch(
    `${BACKEND_URL}/api/utility/session/${id}/force-ocr`,
    { method: 'POST', signal: AbortSignal.timeout(10000) },
  );

  let liveId = sessionId;
  let res: Response | null = null;
  try {
    res = await doFetch(liveId);
  } catch {
    // Network-level failure (offline, CORS-blocked 404, timeout). Attempt
    // the same reupload-recovery path the other endpoints use.
  }

  // Backend evicted the session, or the network-blocked response was
  // actually a 404. Reupload the file and retry once.
  if ((res === null || res.status === 404) && opts.file) {
    const newId = await reprocessFile(opts.file);
    if (newId) {
      opts.onSessionRenewed?.(liveId, newId);
      liveId = newId;
      try {
        res = await doFetch(liveId);
      } catch { return null; }
    }
  }

  if (!res || !res.ok) return null;
  try {
    const data = await res.json();
    return { total_pages: data.total_pages, sessionId: liveId };
  } catch {
    return null;
  }
}

/** Rotate every page in the session's PDF by `delta` degrees (multiple
 *  of 90) and bake the rotation in. After this returns the session's
 *  PDF has rotation=0 on every page; the caller should refetch
 *  /pdf and any derived data. */
export async function rotateSessionPdf(
  sessionId: string,
  delta: number,
): Promise<{ page_count: number } | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/api/utility/session/${sessionId}/rotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delta }),
      signal: AbortSignal.timeout(60_000),  // rotation re-renders every page
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function getOcrProgress(sessionId: string): Promise<OcrProgress | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/api/utility/session/${sessionId}/ocr-progress`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return await res.json() as OcrProgress;
  } catch {
    return null;
  }
}