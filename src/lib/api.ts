/* eslint-disable @typescript-eslint/no-explicit-any */
import type { PageInfo, Highlight, ExtractedRow } from '@/types/utilscraper';
import { extractFromRegions } from './pdf-extract';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000' ;

// Strip emoji, dingbats, decorative symbols, and hidden binary strings from extracted text
function sanitizeValue(val: string | null | undefined): string | null {
  if (!val) return val ?? null;
  const cleaned = val
    .replace(/[^\p{L}\p{N}\p{P}\p{Z}\p{Sc}\p{Sm}]/gu, '')
    .replace(/\b[01]{8,}\b/g, '')       // strip binary-encoded hidden numbers (8+ digits of only 0/1)
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || null;
}

// ---------------------------------------------------------------------------
// Date normalisation for lease contracts and other date fields.
//
// Scanned PDFs frequently produce garbled date strings such as:
//   "Ist.. day ofSeptember2025"  →  should become "09/01/2025"
//   "3Oth day ofJune2026"        →  should become "06/30/2026"
//
// Steps:
//  1. Fix common OCR digit↔letter swaps (I→1, O→0, l→1)
//  2. Remove stray dots & scan noise
//  3. Insert missing spaces between letters↔digits
//  4. Strip ordinal suffixes (st, nd, rd, th) and filler words (day, of, the)
//  5. Parse "D Month YYYY" or "Month D YYYY" into MM/DD/YYYY
// ---------------------------------------------------------------------------
const MONTH_MAP: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7,
  aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function normalizeDateValue(raw: string): string {
  let s = raw;

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

  // --- Try to parse "D Month YYYY" or "Month D YYYY" ---
  // Pattern A: "1 September 2025"
  const patA = s.match(/^(\d{1,2})\s+([a-zA-Z]+)\s+(\d{4})$/);
  if (patA) {
    const month = MONTH_MAP[patA[2].toLowerCase()];
    if (month) {
      const day = parseInt(patA[1], 10);
      return `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/${patA[3]}`;
    }
  }

  // Pattern B: "September 1 2025"
  const patB = s.match(/^([a-zA-Z]+)\s+(\d{1,2})\s+(\d{4})$/);
  if (patB) {
    const month = MONTH_MAP[patB[1].toLowerCase()];
    if (month) {
      const day = parseInt(patB[2], 10);
      return `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/${patB[3]}`;
    }
  }

  // Pattern C: "Month YYYY" (no day — default to 1st)
  const patC = s.match(/^([a-zA-Z]+)\s+(\d{4})$/);
  if (patC) {
    const month = MONTH_MAP[patC[1].toLowerCase()];
    if (month) {
      return `${String(month).padStart(2, '0')}/01/${patC[2]}`;
    }
  }

  // If already in a numeric date format, return as-is (e.g. "09/01/2025", "9-1-2025")
  return s;
}

const DATE_FIELDS = new Set([
  'billing_date', 'statement_date', 'appraised_date',
  'lease_date', 'lease_begin_date', 'lease_end_date',
]);

const AMOUNT_FIELDS = new Set([
  'total_gas_bill', 'total_electricity_bill', 'total_internet_bill',
  'total_phone_bill', 'total_water_bill', 'total_sewer_bill',
  'total_water_sewer_bill', 'total_trash_bill',
  'beginning_balance', 'ending_balance', 'total_credits', 'total_debits',
  'appraised_as_is_value',
  'security_deposit', 'rent_and_charges',
  'onetime_concession_amount', 'monthly_discount', 'other_discount',
]);

// ---------------------------------------------------------------------------
// Amount normalisation — ensures values like "$1,234.56" are clean.
// Fixes OCR artifacts like "12.12.1531" (multiple decimals) by keeping
// only the last dot as the decimal separator.
// ---------------------------------------------------------------------------
function normalizeAmountValue(raw: string): string {
  // Strip everything except digits, dots, commas, minus, and $
  let s = raw.replace(/[^0-9.,$-]/g, '').trim();

  // Remove $ and commas
  s = s.replace(/[$,]/g, '');

  // Detect two amounts glued together: "32965.1416883.36"
  // Pattern: a number with decimals immediately followed by another number with decimals
  const concatMatch = s.match(/^(-?\d+\.\d{2})(\d+\.\d{2})$/);
  if (concatMatch) {
    // Take only the first amount
    s = concatMatch[1];
  }

  // Also catch: "145693032624.10" where "14569.30" + "32624.10" lost the dot
  // Heuristic: if there's exactly one dot and the digits before it are > 8 chars,
  // it's likely two amounts concatenated. Extract the first valid amount.
  const dotIdx = s.indexOf('.');
  if (dotIdx >= 0) {
    const beforeDot = s.slice(0, dotIdx);
    const afterDot = s.slice(dotIdx + 1);
    // If after the decimal there are more than 2 digits, something is wrong
    // e.g. "160287633819.74" — the "74" is fine, but the integer part is suspiciously long
    // Check if the raw string had spaces or multiple numbers
    if (afterDot.length === 2 && beforeDot.length > 6) {
      // Try to find a valid split: look for a .XX pattern in the original raw text
      const amounts = raw.match(/-?\$?[\d,]+\.\d{2}/g);
      if (amounts && amounts.length >= 1) {
        const first = amounts[0].replace(/[$,]/g, '');
        const num = parseFloat(first);
        if (!isNaN(num)) return num.toFixed(2);
      }
    }
  }

  // Handle multiple dots: "12.12.1531" → two amounts, take the first
  const dotCount = (s.match(/\./g) || []).length;
  if (dotCount > 1) {
    // Try to extract the first valid amount
    const firstAmount = s.match(/^(-?\d+\.\d{2})/);
    if (firstAmount) {
      s = firstAmount[1];
    } else {
      // Fallback: keep only last dot as decimal
      const lastDot = s.lastIndexOf('.');
      s = s.slice(0, lastDot).replace(/\./g, '') + s.slice(lastDot);
    }
  }

  // Validate: should be a number now
  const num = parseFloat(s);
  if (isNaN(num)) return raw;

  // Format: always show 2 decimal places for money
  return num.toFixed(2);
}

function sanitizeResults(results: ExtractedRow[]): ExtractedRow[] {
  return results.map(r => {
    let value = sanitizeValue(r.value);
    if (value && DATE_FIELDS.has(r.field)) {
      value = normalizeDateValue(value);
    }
    if (value && AMOUNT_FIELDS.has(r.field)) {
      value = normalizeAmountValue(value);
    }
    return { ...r, value };
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

// ---------------------------------------------------------------------------
// processFile — upload PDF, detect pages, run OCR on scanned pages
// ---------------------------------------------------------------------------
// Word-format detection — these can't be parsed client-side via pdfjs, so
// if the backend fails we must surface the error instead of silently
// falling through to a fallback that will never work.
const isWordFile = (f: File) =>
  f.type === 'application/msword'
  || f.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  || /\.docx?$/i.test(f.name);

// After the backend converts a Word upload, fetch the resulting PDF bytes
// so the viewer can render (react-pdf can't read .doc/.docx directly).
// Returns a File that can replace the original session.file.
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

        // For Word uploads the browser holds only the .docx/.doc blob,
        // which react-pdf can't render. Pull the converted PDF bytes
        // back from the backend so the viewer has something to show.
        let convertedPdf: File | undefined;
        if (wordDoc) {
          onProgress(2, 'Fetching converted PDF...');
          const pdf = await fetchConvertedPdf(data.session_id, file.name);
          if (pdf) convertedPdf = pdf;
          else {
            throw new Error(
              'Backend accepted the Word document but did not expose the converted PDF. '
              + 'Ask ops to implement GET /api/utility/session/{session_id}/pdf.',
            );
          }
        }

        onProgress(3, `Ready — ${data.ocr_pages_count ?? 0} pages OCR'd`);
        return {
          session_id: data.session_id,
          total_pages: data.total_pages,
          pages: data.pages,
          convertedPdf,
        };
      }

      // Non-OK response — lift the detail out of the body and throw a
      // friendly error. Word-specific errors (415 / 500 from LibreOffice)
      // need to surface; falling through would just crash pdfjs.
      let detail = '';
      try {
        const body = await res.json();
        // FastAPI uses `detail`; legacy handlers use `error` or `message`.
        detail = body.detail || body.error || body.message || '';
      } catch { /* body may be empty or non-JSON */ }

      // The deployed backend hasn't shipped DOC/DOCX support yet — its
      // validator still rejects with "Only PDF files are supported".
      // Make that case obvious to the user.
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

// ---------------------------------------------------------------------------
// extractRegions — MANUAL HIGHLIGHT MODE
// Extracts ONLY the regions the user drew highlight boxes over.
// Sends all highlights from ALL pages to backend in one call.
// ---------------------------------------------------------------------------
export async function extractRegions(
  sessionId: string,
  highlights: Highlight[],
  file?: File,
): Promise<ExtractedRow[]> {

  // Must have at least one highlight
  if (!highlights || highlights.length === 0) {
    return [];
  }

  // Try backend — sends highlights from ALL pages at once
  try {
    if (backendOnline && !sessionId.startsWith('local-')) {
      const body = JSON.stringify({
        session_id: sessionId,
        highlights: highlights.map(h => ({
          page: h.page, field: h.field,
          x: h.x, y: h.y, width: h.width, height: h.height,
        })),
      });

      let res = await fetch(`${BACKEND_URL}/api/utility/extract-regions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      // 404 = session expired — re-process the file and retry once
      if (res.status === 404 && file) {
        console.warn('Session expired — re-uploading file and retrying...');
        const formData = new FormData();
        formData.append('file', file);
        const reprocess = await fetch(`${BACKEND_URL}/api/utility/process`, {
          method: 'POST',
          body: formData,
        });
        if (reprocess.ok) {
          const redata = await reprocess.json();
          const retryBody = JSON.stringify({
            session_id: redata.session_id,
            highlights: highlights.map(h => ({
              page: h.page, field: h.field,
              x: h.x, y: h.y, width: h.width, height: h.height,
            })),
          });
          res = await fetch(`${BACKEND_URL}/api/utility/extract-regions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: retryBody,
          });
        }
      }

      if (res.ok) {
        const data = await res.json();
        return sanitizeResults(data.results);
      }
    }
  } catch {
    /* fall through to client-side */
  }

  // Client-side fallback — uses pdfjs text layer
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

      // If any results came back with wasOcr:true it means that page is scanned
      // and pdfjs couldn't read it — try the backend for those specific highlights
      const ocrNeeded = clientResults.filter(r => r.wasOcr && r.value === null);
      const goodResults = clientResults.filter(r => !r.wasOcr || r.value !== null);

      if (ocrNeeded.length > 0 && backendOnline && !sessionId.startsWith('local-')) {
        try {
          const ocrHighlights = highlights.filter(h =>
            ocrNeeded.some(r => r.page === h.page && r.field === h.field)
          );
          const res = await fetch(`${BACKEND_URL}/api/utility/extract-regions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              session_id: sessionId,
              highlights: ocrHighlights.map(h => ({
                page: h.page, field: h.field,
                x: h.x, y: h.y, width: h.width, height: h.height,
              })),
            }),
          });
          if (res.ok) {
            const data = await res.json();
            return sanitizeResults([...goodResults, ...data.results]);
          }
        } catch { /* backend retry failed, return what we have */ }
      }

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