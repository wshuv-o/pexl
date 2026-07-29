/* eslint-disable no-useless-escape */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { pdfjs } from 'react-pdf';
import type { ExtractedRow, FieldLabel, Highlight } from '@/types/utilscraper';

// Set worker once at module load — covers calls from Index.tsx dynamic imports
// that happen before (or without) PDFViewer mounting.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

// ---------------------------------------------------------------------------
// Document-proxy cache — parse each PDF only once per session.
//
// Without this, a 310-page PDF with 5 auto-extract pairs would call
// file.arrayBuffer() + pdfjs.getDocument() ~1 600 times (≈17 GB of reads)
// and crash the browser. With the cache the PDF is parsed once (~11 MB) and
// all subsequent page operations reuse the same PDFDocumentProxy.
//
// The cache is now LRU-bounded. During a batch extract on 300+ PDFs the
// old TTL-only eviction (10 min) let every document stay pinned in memory
// simultaneously — 300 × ~10–30 MB apiece easily OOM'd the browser tab.
// MAX_DOC_ENTRIES caps concurrent live proxies. On insert we evict the
// LRU entries (revoking their blob URLs so pdfjs can drop the underlying
// data) until we're under the cap. `get` also touches an entry so it
// moves to the MRU end.
// ---------------------------------------------------------------------------
const MAX_DOC_ENTRIES = 12;
const MAX_PAGE_CONTENT_ENTRIES = 60;
const _docCache = new Map<string, { proxy: any; ts: number; blobUrl: string }>();

// Per-page text-content cache — one getTextContent() call shared between
// detectTableRegionsInPdfPage and findAllTextPositionsInPdfPage so the pdfjs
// worker is not hit twice for the same page during auto-apply.
const _pageContentCache = new Map<string, { items: any[]; vp: any; ts: number }>();

function _fileKey(file: File) { return `${file.name}::${file.size}::${file.lastModified}`; }

// LRU touch — remove and re-insert so the entry becomes the newest.
function _touchDoc(key: string, entry: { proxy: any; ts: number; blobUrl: string }) {
  _docCache.delete(key);
  entry.ts = Date.now();
  _docCache.set(key, entry);
}
function _touchPage(key: string, entry: { items: any[]; vp: any; ts: number }) {
  _pageContentCache.delete(key);
  entry.ts = Date.now();
  _pageContentCache.set(key, entry);
}
// Evict the least-recently-used entries when we're over the cap.
function _evictOverCap<T>(
  map: Map<string, T>,
  cap: number,
  onEvict?: (v: T) => void,
) {
  while (map.size > cap) {
    const firstKey = map.keys().next().value;
    if (firstKey === undefined) break;
    const v = map.get(firstKey);
    map.delete(firstKey);
    if (v && onEvict) onEvict(v);
  }
}

async function getPageContentCached(
  file: File, pdf: any, pageNumber: number,
): Promise<{ page: any; items: any[]; vp: any }> {
  const key = `${_fileKey(file)}::${pageNumber}`;
  const page = await pdf.getPage(pageNumber);
  const hit = _pageContentCache.get(key);
  if (hit) { _touchPage(key, hit); return { page, items: hit.items, vp: hit.vp }; }
  const vp      = page.getViewport({ scale: 1 });
  const content = await page.getTextContent({ includeMarkedContent: false });
  const items   = content.items as any[];
  _pageContentCache.set(key, { items, vp, ts: Date.now() });
  _evictOverCap(_pageContentCache, MAX_PAGE_CONTENT_ENTRIES);
  return { page, items, vp };
}

async function getDocumentCached(file: File): Promise<any> {
  const key = _fileKey(file);
  const hit = _docCache.get(key);
  if (hit) { _touchDoc(key, hit); return hit.proxy; }

  // Use a blob URL so the worker fetches pages on demand via range requests
  // instead of receiving the entire ArrayBuffer via postMessage (which stalls
  // the browser for large PDFs and can OOM the worker for 200-300 page files).
  const blobUrl = URL.createObjectURL(file);
  const proxy = await pdfjs.getDocument({
    url: blobUrl,
    standardFontDataUrl: '/standard_fonts/',
  }).promise;
  _docCache.set(key, { proxy, ts: Date.now(), blobUrl });
  _evictOverCap(_docCache, MAX_DOC_ENTRIES, (v) => {
    // Free the underlying PDF document + revoke its blob URL so pdfjs can
    // GC the parsed data. Without this, evicted proxies stay reachable via
    // the browser's URL registry and hold their arrays alive.
    try { v.proxy.destroy?.(); } catch { /* ignore */ }
    URL.revokeObjectURL(v.blobUrl);
  });
  return proxy;
}

/** Free every cached document EXCEPT the given files. Used after a batch
 *  extract to reclaim the memory of the (potentially hundreds of) processed
 *  PDFs while KEEPING the documents the user is still looking at (open tabs)
 *  warm — so a single-row Re-extract on one of them is instant instead of
 *  paying a full cold pdfjs reload + text re-parse of the whole PDF. */
export function clearDocumentCacheExcept(keepFiles: File[]): void {
  const keep = new Set(keepFiles.filter(Boolean).map(_fileKey));
  for (const [key, v] of Array.from(_docCache.entries())) {
    if (keep.has(key)) continue;
    try { v.proxy.destroy?.(); } catch { /* ignore */ }
    URL.revokeObjectURL(v.blobUrl);
    _docCache.delete(key);
  }
  for (const k of Array.from(_pageContentCache.keys())) {
    // page-content key is `${_fileKey}::${pageNumber}` — the doc key is the
    // first three ::-separated segments.
    const docKey = k.split('::').slice(0, 3).join('::');
    if (!keep.has(docKey)) _pageContentCache.delete(k);
  }
}

/** Call this when a session is closed, or after a large batch extract, to
 *  free the cached documents. Explicitly destroys the pdfjs proxies so the
 *  worker can drop the parsed page arrays — revoking blob URLs alone isn't
 *  enough because pdfjs holds internal references. */
export function clearDocumentCache(file?: File): void {
  const destroy = (v: { proxy: any; blobUrl: string }) => {
    try { v.proxy.destroy?.(); } catch { /* ignore */ }
    URL.revokeObjectURL(v.blobUrl);
  };
  if (file) {
    const key = _fileKey(file);
    const entry = _docCache.get(key);
    if (entry) destroy(entry);
    _docCache.delete(key);
    for (const k of _pageContentCache.keys()) {
      if (k.startsWith(key + '::')) _pageContentCache.delete(k);
    }
  } else {
    for (const v of _docCache.values()) destroy(v);
    _docCache.clear();
    _pageContentCache.clear();
  }
}

// ---------------------------------------------------------------------------
// Extract all text from a PDF file, page by page
// ---------------------------------------------------------------------------
export async function extractTextFromPdf(file: File): Promise<Map<number, string>> {
  const pdf = await getDocumentCached(file);
  const pageTexts = new Map<number, string>();

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((item: any) => item.str)
      .join(' ')
      .replace(/\b[01]{8,}\b/g, '')  // strip binary-encoded hidden numbers
      .replace(/\s+/g, ' ')
      .trim();
    pageTexts.set(i, text);
  }

  return pageTexts;
}

// ---------------------------------------------------------------------------
// Provider field extraction patterns (client-side fallback)
// ---------------------------------------------------------------------------
interface ProviderPatterns {
  provider_name: RegExp[];
  property_name: RegExp[];
  account_number: RegExp[];
  address: RegExp[];
  billing_date: RegExp[];
  total_gas_bill: RegExp[];
}

const PROVIDER_PATTERNS: Record<string, ProviderPatterns> = {
  'National Grid Gas': {
    provider_name: [
      /(?:provider|utility|company|supplier)[:\s]*([A-Z][A-Za-z\s&.,'-]{2,40})/i,
      /^([A-Z][A-Z\s&]{2,30}(?:GRID|EDISON|ELECTRIC|GAS|ENERGY|POWER|FUEL|WATER))\b/im,
      /^([A-Z][A-Z\s&.,'-]{3,40})\s*(?:LLC|INC|CORP|LTD|CO\b)/im,
    ],
    property_name: [
      /(?:property\s*(?:name)?|customer\s*name|name\s*on\s*account|bill\s*to|service\s*for)[:\s]*([A-Z][A-Za-z\s&.,'-]{2,50})/i,
      /(?:account\s*holder)[:\s]*([A-Z][A-Za-z\s&.,'-]{2,50})/i,
      /^([A-Z][A-Z\s&.,'-]{5,40})\s*(?:LLC|INC|CORP|LTD|CO\b)/im,
      /(?:property\s*(?:name)?|customer\s*name|bill\s*to)[:\s]*([A-Za-z][A-Za-z\s&.,'-]{2,50})/i,
    ],
    account_number: [
      /(?:account\s*(?:no|number|#|num))[.:\s]*([0-9][0-9\s-]{5,25})/i,
      /(?:acct\s*(?:no|number|#)?)[.:\s]*([0-9][0-9\s-]{5,25})/i,
      /\b(\d{4}[\s-]\d{4}[\s-]\d{4}(?:[\s-]\d{2,4})?)\b/,
      /\b(\d{10,16})\b/,
    ],
    address: [
      /(?:service\s*address|premises|location)[:\s]*(.{10,80})/i,
      /(\d{1,5}\s+[A-Z][a-zA-Z\s]+(?:St|Ave|Blvd|Rd|Dr|Ln|Way|Pl|Ct|Cir|Pkwy|Terr)[.,]?\s*(?:(?:Apt|Ste|Unit|Fl|Floor|#)\s*\S+)?[,\s]+[A-Za-z\s]+,?\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?)/i,
      /(\d{1,5}\s+\w[\w\s]{3,30}(?:St|Ave|Blvd|Rd|Dr|Ln|Way|Pl|Ct))/i,
    ],
    billing_date: [
      /(?:bill(?:ing)?\s*date|statement\s*date|invoice\s*date|date\s*of\s*bill)[:\s]*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i,
      /(?:bill(?:ing)?\s*date|statement\s*date)[:\s]*([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i,
      /(?:period\s*(?:from|ending|through))[:\s]*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i,
      /(?:due\s*date)[:\s]*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i,
    ],
    total_gas_bill: [
      /(?:total\s*(?:amount\s*)?(?:due|owed|charges?)|amount\s*due|balance\s*due|total\s*(?:gas\s*)?bill|new\s*balance|total\s*current\s*charges)[:\s]*\$?\s*([0-9,]+\.?\d{0,2})/i,
      /\$\s*([0-9,]+\.\d{2})\s*(?:total|due|amount)/i,
      /(?:please\s*pay)[:\s]*\$?\s*([0-9,]+\.\d{2})/i,
    ],
  },
};

for (const p of ['Con Edison', 'PSEG', 'National Fuel', 'KeySpan']) {
  PROVIDER_PATTERNS[p] = { ...PROVIDER_PATTERNS['National Grid Gas'] };
}

PROVIDER_PATTERNS['Con Edison'] = {
  ...PROVIDER_PATTERNS['National Grid Gas'],
  total_gas_bill: [
    /(?:total\s*amount\s*due|amount\s*due|total\s*charges)[:\s]*\$?\s*([0-9,]+\.?\d{0,2})/i,
    /(?:electric\s*&?\s*gas\s*charges)[:\s]*\$?\s*([0-9,]+\.?\d{0,2})/i,
    ...PROVIDER_PATTERNS['National Grid Gas'].total_gas_bill,
  ],
};

function isScannedPage(items: any[]): boolean {
  const textItems = items.filter((i: any) => i.str && i.str.trim().length > 0);
  return textItems.length < 10;
}

interface ItemAABB {
  left: number;   right: number;
  top: number;    bottom: number;  // top-down (from page top)
  centerX: number; centerY: number;
  width: number;  height: number;
}

function itemAABB(item: any, pageHeight: number): ItemAABB {
  const [a, b, , , tx, ty] = item.transform;
  const w  = item.width  || item.str.length * 6;
  const h  = item.height || Math.abs(item.transform[3]) || 12;
  const angle = Math.atan2(b, a);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  // Four corners in PDF coords (origin = baseline-left, y-up)
  //   Along width direction: (cos, sin)
  //   Along height direction (upward from baseline): (-sin, cos)
  const corners = [
    { x: tx,                          y: ty },
    { x: tx + w * cos,                y: ty + w * sin },
    { x: tx - h * sin,                y: ty + h * cos },
    { x: tx + w * cos - h * sin,      y: ty + w * sin + h * cos },
  ];

  const xs = corners.map(c => c.x);
  const ys = corners.map(c => c.y);

  const left   = Math.min(...xs);
  const right  = Math.max(...xs);
  // Convert to top-down Y (from page top)
  const top    = pageHeight - Math.max(...ys);
  const bottom = pageHeight - Math.min(...ys);

  return {
    left, right, top, bottom,
    centerX: (left + right) / 2,
    centerY: (top + bottom) / 2,
    width: right - left,
    height: bottom - top,
  };
}

// ---------------------------------------------------------------------------
// Value-pattern candidate finder (for guided auto-highlight on amount /
// date / year fields). Skips the label search entirely — instead scans the
// PDF for tokens that look like the requested value type and returns each
// match's bbox in normalized 0-1 coords. The user then picks the right
// match in the search bar; no Right/Below offset needed because the match
// itself IS the value.
// ---------------------------------------------------------------------------
export type ValueKind = 'amount' | 'date' | 'year' | 'percent';

export interface ValueCandidate {
  page: number;
  text: string;
  box: { x: number; y: number; width: number; height: number };
}

const VALUE_PATTERNS: Record<ValueKind, RegExp> = {
  // $1,234 / $1,234.50 / 1,234.50 / 145.20  — requires either thousand
  // separators OR two decimals to avoid matching every bare integer.
  amount: /(?:\$\s*)?(?:\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+\.\d{2})/g,
  // Numeric MM/DD/YYYY · DD-MM-YYYY · YYYY-MM-DD · or "Month D, YYYY" · "D Month YYYY"
  date: /\b(?:\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}|\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{4})\b/gi,
  // Standalone 4-digit year 1900-2099. Note: this also matches the year
  // portion of full dates — that's fine, the user picks which they want.
  year: /\b(?:19|20)\d{2}\b/g,
  // Percent-shaped tokens: "6%", "6.5%", "6.50%", "10%", or a leading-zero
  // decimal like "0.065" / ".065". Anchored to either a % sign or the
  // "0." form so we don't match every random number on the page.
  percent: /\b\d{1,2}(?:\.\d{1,4})?\s*%|\b0?\.\d{2,4}\b/g,
};

export async function findValueCandidates(
  file: File,
  kind: ValueKind,
  startPage = 1,
  endPage?: number,
): Promise<ValueCandidate[]> {
  const pdf = await getDocumentCached(file);
  const last = endPage ?? pdf.numPages;
  const out: ValueCandidate[] = [];

  for (let p = startPage; p <= last; p++) {
    if (p % 10 === 0) await new Promise(r => setTimeout(r, 0));
    const page = await pdf.getPage(p);
    const content = await page.getTextContent({ includeMarkedContent: false });
    const vp = page.getViewport({ scale: 1 });
    const items = content.items as any[];
    if (isScannedPage(items)) continue;

    // Group items into rough lines so a value split across multiple
    // text items (e.g. "$" + "1,234.50") gets matched as one token.
    const enriched = items
      .filter((it: any) => it.str)
      .map((it: any) => ({ it, aabb: itemAABB(it, vp.height) }));

    enriched.sort((a, b) => {
      const dy = a.aabb.top - b.aabb.top;
      if (Math.abs(dy) > 4) return dy;
      return a.aabb.left - b.aabb.left;
    });

    type LineEntry = { str: string; aabb: ItemAABB };
    const lines: LineEntry[][] = [];
    let curLine: LineEntry[] = [];
    let curY: number | null = null;
    for (const e of enriched) {
      const y = e.aabb.centerY;
      if (curY === null || Math.abs(y - curY) <= 4) {
        curLine.push({ str: e.it.str, aabb: e.aabb });
        curY = curY === null ? y : (curY + y) / 2;
      } else {
        if (curLine.length) lines.push(curLine);
        curLine = [{ str: e.it.str, aabb: e.aabb }];
        curY = y;
      }
    }
    if (curLine.length) lines.push(curLine);

    const pattern = VALUE_PATTERNS[kind];
    for (const line of lines) {
      // Build a flat string + char-offset → item map so we can find which
      // items each match covers.
      let acc = '';
      const charToItem: number[] = [];   // char index → line item index
      for (let i = 0; i < line.length; i++) {
        const s = line[i].str;
        for (let c = 0; c < s.length; c++) charToItem.push(i);
        acc += s;
      }
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(acc)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (end <= start) { pattern.lastIndex++; continue; }
        const firstItem = charToItem[start];
        const lastItem  = charToItem[Math.min(end - 1, charToItem.length - 1)];
        if (firstItem == null || lastItem == null) continue;

        let left   = Infinity;
        let right  = -Infinity;
        let top    = Infinity;
        let bottom = -Infinity;
        for (let i = firstItem; i <= lastItem; i++) {
          const a = line[i].aabb;
          left   = Math.min(left,   a.left);
          right  = Math.max(right,  a.right);
          top    = Math.min(top,    a.top);
          bottom = Math.max(bottom, a.bottom);
        }
        out.push({
          page: p,
          text: m[0].trim(),
          box: {
            x: clamp01(left / vp.width),
            y: clamp01(top  / vp.height),
            width:  clamp01((right  - left) / vp.width),
            height: clamp01((bottom - top)  / vp.height),
          },
        });
      }
    }
  }
  return out;
}

function clamp01(v: number) { return Math.max(0, Math.min(1, v)); }

// ---------------------------------------------------------------------------
// Auto-extract with highlight positions
// ---------------------------------------------------------------------------
export async function autoExtractWithHighlights(
  file: File,
  provider: string,
): Promise<{ rows: ExtractedRow[]; highlights: Record<number, Highlight[]> }> {
  const pdf = await getDocumentCached(file);
  const patterns = PROVIDER_PATTERNS[provider] || PROVIDER_PATTERNS['National Grid Gas'];
  const rows: ExtractedRow[] = [];
  const highlights: Record<number, Highlight[]> = {};

  let lastPropertyName: string | null = null;
  let lastAccountNumber: string | null = null;
  let lastAddress: string | null = null;

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    if (pageNum % 10 === 0) await new Promise(r => setTimeout(r, 0));
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent({ includeMarkedContent: false });
    const viewport = page.getViewport({ scale: 1 });
    const pageWidth = viewport.width;
    const pageHeight = viewport.height;

    // Skip scanned pages — backend OCR needed for those
    if (isScannedPage(content.items as any[])) continue;

    const fullText = content.items
      .map((item: any) => item.str)
      .join(' ')
      .replace(/\b[01]{8,}\b/g, '')  // strip binary-encoded hidden numbers
      .replace(/\s+/g, ' ')
      .trim();

    if (!fullText || fullText.length < 10) continue;

    const pageResults: Record<string, {
      value: string | null;
      confidence: 'high' | 'medium' | 'low';
      matchedText?: string;
    }> = {};

    for (const [field, fieldPatterns] of Object.entries(patterns) as [FieldLabel, RegExp[]][]) {
      let found: string | null = null;
      let confidence: 'high' | 'medium' | 'low' = 'low';

      for (let pi = 0; pi < fieldPatterns.length; pi++) {
        const match = fullText.match(fieldPatterns[pi]);
        if (match && match[1]) {
          found = match[1].trim();
          confidence = pi <= 1 ? 'high' : 'medium';
          break;
        }
      }
      pageResults[field] = { value: found, confidence, matchedText: found || undefined };
    }

    // Carry-forward
    if (pageResults.property_name.value) lastPropertyName = pageResults.property_name.value;
    else if (lastPropertyName) pageResults.property_name = { value: lastPropertyName, confidence: 'medium' };

    if (pageResults.account_number.value) lastAccountNumber = pageResults.account_number.value;
    else if (lastAccountNumber) pageResults.account_number = { value: lastAccountNumber, confidence: 'medium' };

    if (pageResults.address.value) lastAddress = pageResults.address.value;
    else if (lastAddress) pageResults.address = { value: lastAddress, confidence: 'medium' };

    const pageHls: Highlight[] = [];
    for (const [field, result] of Object.entries(pageResults)) {
      if (!result.value) continue;

      rows.push({
        page: pageNum,
        field,
        value: result.value,
        confidence: result.confidence,
        wasOcr: false,
      });

      if (result.matchedText) {
        const hlRect = findTextPosition(
          content.items as any[],
          result.matchedText,
          pageWidth,
          pageHeight,
        );
        if (hlRect) {
          pageHls.push({
            id: `auto-${pageNum}-${field}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
            page: pageNum,
            field: field as FieldLabel,
            x: hlRect.x,
            y: hlRect.y,
            width: hlRect.width,
            height: hlRect.height,
            extractedValue: result.value,
            confidence: result.confidence,
            wasOcr: false,
          });
        }
      }
    }

    if (pageHls.length > 0) highlights[pageNum] = pageHls;
  }

  return { rows, highlights };
}

function findTextPosition(
  items: any[],
  searchText: string,
  pageWidth: number,
  pageHeight: number,
): { x: number; y: number; width: number; height: number } | null {
  const searchLower = searchText.toLowerCase().trim();
  const searchWords = searchLower.split(/\s+/).filter(w => w.length > 1);
  if (searchWords.length === 0) return null;

  // Score every text item
  const scored: { item: any; score: number }[] = [];
  for (const item of items) {
    if (!item.str || !item.transform) continue;
    const itemLower = item.str.toLowerCase();
    let score = 0;
    for (const word of searchWords) {
      if (itemLower.includes(word)) score++;
    }
    if (score > 0) scored.push({ item, score });
  }

  if (scored.length === 0) return null;

  // Take only items with the highest score (best matches)
  const maxScore = Math.max(...scored.map(s => s.score));
  const best = scored.filter(s => s.score === maxScore).map(s => s.item);

  const sorted = best.slice().sort((a, b) => {
    const bbA = itemAABB(a, pageHeight);
    const bbB = itemAABB(b, pageHeight);
    return bbA.top - bbB.top;
  });
  // Take only the topmost item to get the tightest, most accurate box
  const selected = [sorted[0]];

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const item of selected) {
    const bb = itemAABB(item, pageHeight);
    minX = Math.min(minX, bb.left);
    minY = Math.min(minY, bb.top);
    maxX = Math.max(maxX, bb.right);
    maxY = Math.max(maxY, bb.bottom);
  }

  // Add small padding
  const pad = 3;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(pageWidth, maxX + pad);
  maxY = Math.min(pageHeight, maxY + pad);

  return {
    x: minX / pageWidth,
    y: minY / pageHeight,
    width: (maxX - minX) / pageWidth,
    height: (maxY - minY) / pageHeight,
  };
}

export async function extractFromRegions(
  file: File,
  highlights: { page: number; field: string; x: number; y: number; width: number; height: number }[],
): Promise<ExtractedRow[]> {
  const pdf = await getDocumentCached(file);

  // Group highlights by page so we open each page only once.
  const byPage = new Map<number, typeof highlights>();
  for (const h of highlights) {
    if (!byPage.has(h.page)) byPage.set(h.page, []);
    byPage.get(h.page)!.push(h);
  }

  // Process all pages concurrently — each page is an independent pdfjs worker call.
  const pageChunks = await Promise.all(
    Array.from(byPage.entries()).map(async ([, pageHighlights]) => {
      const pg = pageHighlights[0].page;
      const { items, vp: viewport } = await getPageContentCached(file, pdf, pg);
      const pageWidth  = viewport.width;
      const pageHeight = viewport.height;
      const scanned    = isScannedPage(items);
      const chunk: ExtractedRow[] = [];

      for (const hl of pageHighlights) {
        if (scanned) {
          chunk.push({ page: hl.page, field: hl.field, value: null, confidence: 'low', wasOcr: true });
          continue;
        }

        const hlLeft   = hl.x * pageWidth;
        const hlRight  = (hl.x + hl.width)  * pageWidth;
        const hlTop    = hl.y * pageHeight;
        const hlBottom = (hl.y + hl.height) * pageHeight;

        const matchedItems: { x: number; y: number; str: string }[] = [];
        for (const item of items) {
          if (!item.str || !item.transform) continue;
          const str = item.str;
          if (!str.trim()) continue;
          if (/^[01]{8,}$/.test(str.trim())) continue;
          const bb = itemAABB(item, pageHeight);
          const inRow = bb.centerY >= hlTop && bb.centerY <= hlBottom;
          const xOverlap = Math.min(bb.right, hlRight) - Math.max(bb.left, hlLeft);
          const inCol = bb.width > 0 && (xOverlap / bb.width) >= 0.4;
          if (inRow && inCol) matchedItems.push({ x: bb.left, y: bb.top, str });
        }

        const deduped: typeof matchedItems = [];
        for (const item of matchedItems) {
          const isDup = deduped.some(
            d => d.str === item.str && Math.abs(d.x - item.x) < 4 && Math.abs(d.y - item.y) < 4,
          );
          if (!isDup) deduped.push(item);
        }

        deduped.sort((a, b) => {
          const lineDiff = a.y - b.y;
          if (Math.abs(lineDiff) > 6) return lineDiff;
          return a.x - b.x;
        });

        let finalItems = deduped;
        if (deduped.length > 1) {
          const firstY    = deduped[0].y;
          const firstLine = deduped.filter(i => Math.abs(i.y - firstY) <= 6);
          const restLine  = deduped.filter(i => Math.abs(i.y - firstY) > 6);
          if (restLine.length > 0 && firstLine.map(i => i.str).join('').trim().length >= 3) {
            finalItems = firstLine;
          }
        }

        const rawJoined = finalItems.map(i => i.str).join(' ');
        const value = rawJoined
          .replace(/\(\d+\)/g, '')
          .replace(/[()]/g, '')
          .replace(/[^\p{L}\p{N}\p{P}\p{Z}\p{Sc}\p{Sm}]/gu, '')
          .replace(/\b[01]{8,}\b/g, '')
          .replace(/\s+/g, ' ')
          .trim() || null;

        chunk.push({
          page:       hl.page,
          field:      hl.field,
          value,
          confidence: value && value.length > 2 ? 'high' : value ? 'medium' : 'low',
          wasOcr:     false,
        });
      }
      return chunk;
    }),
  );

  return pageChunks.flat();
}

/**
 * Merge overlapping or touching table region bboxes into the smallest set
 * of non-overlapping bboxes.
 */
function mergeTableRegions(
  regions: Array<{ x: number; y: number; width: number; height: number }>,
): Array<{ x: number; y: number; width: number; height: number }> {
  if (regions.length <= 1) return regions;
  const TOL = 0.01;
  let arr = [...regions];
  let changed = true;
  while (changed) {
    changed = false;
    const out: typeof arr = [];
    const used = new Uint8Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      if (used[i]) continue;
      let r = arr[i];
      for (let j = i + 1; j < arr.length; j++) {
        if (used[j]) continue;
        const s = arr[j];
        if (r.x <= s.x + s.width + TOL && r.x + r.width >= s.x - TOL &&
            r.y <= s.y + s.height + TOL && r.y + r.height >= s.y - TOL) {
          const x  = Math.min(r.x, s.x);
          const y  = Math.min(r.y, s.y);
          const x2 = Math.max(r.x + r.width,  s.x + s.width);
          const y2 = Math.max(r.y + r.height, s.y + s.height);
          r = { x, y, width: x2 - x, height: y2 - y };
          used[j] = 1; changed = true;
        }
      }
      out.push(r);
    }
    arr = out;
  }
  return arr;
}

/**
 * Detect table regions on a single page using two complementary methods:
 *
 * 1. Border-based (bordered tables): scan the PDF graphics operator list for
 *    rectangle ('re') operations. Cell borders drawn as rectangles cluster
 *    into table bounding boxes. Works regardless of text alignment.
 *
 * 2. Text-alignment (borderless tables): group text items into rows, then
 *    find chains of ≥2 consecutive rows that share column X positions.
 *    Catches whitespace-separated columnar layouts with no visible borders.
 *
 * Results from both methods are merged and deduplicated.
 */
export async function detectTableRegionsInPdfPage(
  file: File,
  pageNumber: number,
): Promise<Array<{ x: number; y: number; width: number; height: number }>> {
  try {
    const pdf = await getDocumentCached(file);
    if (pageNumber < 1 || pageNumber > pdf.numPages) return [];
    const { page, items: cachedItems, vp } = await getPageContentCached(file, pdf, pageNumber);
    const W = vp.width, H = vp.height;
    const regions: Array<{ x: number; y: number; width: number; height: number }> = [];

    // -----------------------------------------------------------------------
    // 1. Border-based: find rectangles in the PDF graphics stream.
    //    PDF 're' op → pdfjs OPS.rectangle (19), or batched in
    //    OPS.constructPath (91) with sub-op code 19.
    // -----------------------------------------------------------------------
    try {
      const opList = await page.getOperatorList();
      const { fnArray, argsArray } = opList as { fnArray: Uint8Array; argsArray: any[] };

      // pdfjs-dist OPS constants (verified from build/pdf.min.mjs):
      const OP_RECT  = 19; // standalone rectangle op
      const OP_CPATH = 91; // constructPath — batches moveTo/lineTo/rect
      // sub-op codes within constructPath args[0]:
      const SUB_MOVE = 13; const SUB_LINE = 14; const SUB_CURV = 15;
      const SUB_RECT = 19; // rectangle (same value as top-level)
      // closePath = 18, curveTo1 = 16, curveTo2 = 17 (no coord extraction needed)

      type RBox = { x: number; y: number; x2: number; y2: number };
      const rects: RBox[] = [];

      const pushRect = (rx: number, ry: number, rw: number, rh: number) => {
        rw = Math.abs(rw); rh = Math.abs(rh);
        if (rw < W * 0.015 || rh < H * 0.003) return; // skip tiny decorative elements
        const top = H - ry - rh; // PDF y-origin is bottom-left; flip to viewport
        rects.push({ x: rx, y: top, x2: rx + rw, y2: top + rh });
      };

      for (let i = 0; i < fnArray.length; i++) {
        const fn = fnArray[i];
        if (fn === OP_RECT) {
          const a = argsArray[i];
          if (Array.isArray(a) && a.length >= 4) pushRect(a[0], a[1], a[2], a[3]);
        } else if (fn === OP_CPATH) {
          const [cmds, coords] = argsArray[i] as [number[], number[]];
          if (!Array.isArray(cmds) || !Array.isArray(coords)) continue;
          let ci = 0;
          for (const cmd of cmds) {
            if (cmd === SUB_RECT) {
              if (ci + 3 < coords.length) { pushRect(coords[ci], coords[ci+1], coords[ci+2], coords[ci+3]); ci += 4; }
            } else if (cmd === SUB_MOVE || cmd === SUB_LINE) { ci += 2; }
            else if (cmd === SUB_CURV)  { ci += 6; }
            else if (cmd === 16 || cmd === 17) { ci += 4; } // curveTo1/2
            // closePath (18): no coords consumed
          }
        }
      }

      // Cluster adjacent/overlapping rects into table regions.
      if (rects.length >= 2) {
        const GAP  = W * 0.025;
        const used = new Uint8Array(rects.length);
        for (let i = 0; i < rects.length; i++) {
          if (used[i]) continue;
          const grp = [i];
          let changed = true;
          while (changed) {
            changed = false;
            let gx1 = Infinity, gy1 = Infinity, gx2 = -Infinity, gy2 = -Infinity;
            for (const gi of grp) {
              gx1 = Math.min(gx1, rects[gi].x);  gy1 = Math.min(gy1, rects[gi].y);
              gx2 = Math.max(gx2, rects[gi].x2); gy2 = Math.max(gy2, rects[gi].y2);
            }
            for (let j = 0; j < rects.length; j++) {
              if (used[j] || grp.includes(j)) continue;
              const r = rects[j];
              if (r.x <= gx2 + GAP && r.x2 >= gx1 - GAP && r.y <= gy2 + GAP && r.y2 >= gy1 - GAP) {
                grp.push(j); used[j] = 1; changed = true;
              }
            }
          }
          if (grp.length < 2) continue;
          used[i] = 1;
          let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
          for (const gi of grp) {
            x1 = Math.min(x1, rects[gi].x);  y1 = Math.min(y1, rects[gi].y);
            x2 = Math.max(x2, rects[gi].x2); y2 = Math.max(y2, rects[gi].y2);
          }
          regions.push({
            x: clamp01(x1 / W), y: clamp01(y1 / H),
            width: clamp01((x2 - x1) / W), height: clamp01((y2 - y1) / H),
          });
        }
      }
    } catch { /* operator list unavailable — graphics-based detection skipped */ }

    // -----------------------------------------------------------------------
    // 2. Text-alignment: rows with ≥2 items sharing column X positions.
    //    Reduced minimum chain length to 2 (from 3) and widened X tolerance
    //    to 4% so more real-world borderless tables are captured.
    // -----------------------------------------------------------------------
    const items = cachedItems;

    type Row = { top: number; bottom: number; xs: number[] };
    const TOL_Y = 3;
    const enriched = items
      .filter((it: any) => it.str?.trim() && it.transform)
      .map((it: any) => {
        const h  = it.height || Math.abs(it.transform[3]) || 12;
        const tp = H - it.transform[5] - h;
        return { x: it.transform[4], top: tp, bottom: tp + h };
      })
      .sort((a, b) => a.top - b.top);

    const rows: Row[] = [];
    let cur: Row | null = null;
    for (const it of enriched) {
      if (!cur || it.top > cur.bottom + TOL_Y) {
        if (cur && cur.xs.length >= 2) rows.push(cur);
        cur = { top: it.top, bottom: it.bottom, xs: [it.x] };
      } else {
        cur.xs.push(it.x);
        cur.bottom = Math.max(cur.bottom, it.bottom);
      }
    }
    if (cur && cur.xs.length >= 2) rows.push(cur);

    if (rows.length >= 2) {
      const TOL_X = W * 0.04;
      const aligns = (a: Row, b: Row) =>
        a.xs.some(ax => b.xs.some(bx => Math.abs(ax - bx) < TOL_X));
      const usedR = new Uint8Array(rows.length);
      for (let i = 0; i < rows.length; i++) {
        if (usedR[i]) continue;
        const grp: number[] = [i];
        for (let j = i + 1; j < rows.length; j++) {
          if (usedR[j]) continue;
          if (rows[j].top - rows[grp[grp.length - 1]].bottom > H * 0.06) break;
          if (aligns(rows[grp[grp.length - 1]], rows[j])) { grp.push(j); usedR[j] = 1; }
          else break;
        }
        if (grp.length < 2) continue;
        usedR[i] = 1;
        const allXs = grp.flatMap(gi => rows[gi].xs);
        const minX  = Math.min(...allXs);
        const maxX  = Math.max(...allXs) + W * 0.15;
        const minY  = rows[grp[0]].top;
        const maxY  = rows[grp[grp.length - 1]].bottom;
        const pad   = W * 0.01;
        regions.push({
          x:      clamp01((minX - pad) / W),
          y:      clamp01((minY - pad) / H),
          width:  clamp01((Math.min(maxX, W) - minX + 2 * pad) / W),
          height: clamp01((maxY - minY + 2 * pad) / H),
        });
      }
    }

    return mergeTableRegions(regions);
  } catch {
    return [];
  }
}

/**
 * Return ALL occurrences of `searchText` on the given page using a
 * normalized (lowercase, diacritic-stripped, punctuation-collapsed) substring
 * match. Lines/words can wrap, and items often arrive split (e.g. "Invoice"
 * + " " + "No"), so we build one normalized string per page with a
 * char-offset → item map and emit one bbox per match.
 *
 * Caller-side spatial scoring (e.g. "match closest to source key position")
 * is what lets auto-extract pick the right cell when the same label appears
 * multiple times on a page (header + footer, repeated table rows, etc.).
 */
export async function findAllTextPositionsInPdfPage(
  file: File,
  pageNumber: number,
  searchText: string,
): Promise<Array<{ x: number; y: number; width: number; height: number }>> {
  if (!searchText || !searchText.trim()) return [];

  try {
    const pdf = await getDocumentCached(file);
    if (pageNumber < 1 || pageNumber > pdf.numPages) return [];
    const { items, vp } = await getPageContentCached(file, pdf, pageNumber);
    // Don't skip pages with few items — appraisal/floor-plan pages legitimately
    // have sparse text (labels + numbers) and should still be searchable.

    const normalize = (s: string) => s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')           // strip combining marks (diacritics)
      .replace(/[^a-z0-9 ]/g, ' ')        // collapse punctuation/symbols to space
      .replace(/\s+/g, ' ')
      .trim();

    const q = normalize(searchText);
    if (!q) return [];

    type Slot = { item: any; itemW: number; start: number; end: number; normLen: number };
    const slots: Slot[] = [];
    let pageText = '';
    for (const item of items) {
      if (!item.str || !item.transform) continue;
      const nText = normalize(item.str);
      if (!nText) continue;
      if (pageText.length > 0 && !pageText.endsWith(' ')) pageText += ' ';
      const start = pageText.length;
      pageText += nText;
      const end = pageText.length;
      const itemW = item.width || item.str.length * 6;
      slots.push({ item, itemW, start, end, normLen: end - start });
    }

    const hits: Array<{ x: number; y: number; width: number; height: number }> = [];
    let searchFrom = 0;
    while (searchFrom <= pageText.length) {
      const matchIdx = pageText.indexOf(q, searchFrom);
      if (matchIdx === -1) break;
      const matchEnd = matchIdx + q.length;

      let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
      let anyOverlap = false;
      for (const slot of slots) {
        const overlapStart = Math.max(slot.start, matchIdx);
        const overlapEnd   = Math.min(slot.end,   matchEnd);
        if (overlapStart >= overlapEnd) continue;
        anyOverlap = true;
        const pStart = (overlapStart - slot.start) / slot.normLen;
        const pEnd   = (overlapEnd   - slot.start) / slot.normLen;
        const item   = slot.item;
        const itemX  = item.transform[4];
        const itemH  = item.height || Math.abs(item.transform[3]) || 12;
        const itemTop = vp.height - item.transform[5] - itemH;
        const xL = itemX + pStart * slot.itemW;
        const xR = itemX + pEnd   * slot.itemW;
        left   = Math.min(left,   xL);
        right  = Math.max(right,  xR);
        top    = Math.min(top,    itemTop);
        bottom = Math.max(bottom, itemTop + itemH);
      }
      if (anyOverlap && right > left && bottom > top) {
        hits.push({
          x:      clamp01(left   / vp.width),
          y:      clamp01(top    / vp.height),
          width:  clamp01((right  - left) / vp.width),
          height: clamp01((bottom - top)  / vp.height),
        });
      }
      searchFrom = matchEnd;
    }

    return hits;
  } catch (err) {
    console.warn('[findAllTextPositionsInPdfPage] error:', err);
    return [];
  }
}

export async function findTextPositionInPdf(
  file: File,
  pageNumber: number,
  searchText: string,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  if (!searchText || !searchText.trim()) return null;

  try {
    const pdf = await getDocumentCached(file);
    if (pageNumber < 1 || pageNumber > pdf.numPages) return null;

    const page    = await pdf.getPage(pageNumber);
    const content = await page.getTextContent({ includeMarkedContent: false });
    const vp      = page.getViewport({ scale: 1 });

    const cleanedSearch = searchText
      .replace(/\$\s*/g, '')   // remove $ signs
      .replace(/,/g, '')        // remove thousand separators
      .trim();

    // Try cleaned version first, fall back to original
    const result =
      findTextPosition(content.items as any[], cleanedSearch, vp.width, vp.height) ??
      findTextPosition(content.items as any[], searchText,    vp.width, vp.height);

    console.debug(
      `[findTextPositionInPdf] page=${pageNumber} search="${cleanedSearch}" →`,
      result ? `x=${result.x.toFixed(3)} y=${result.y.toFixed(3)}` : 'null',
    );

    return result;
  } catch (err) {
    console.warn('[findTextPositionInPdf] error:', err);
    return null;
  }
}

export async function getTextAtRect(
  file: File,
  pageNumber: number,
  rect: { x: number; y: number; width: number; height: number },
): Promise<string> {
  try {
    const pdf = await getDocumentCached(file);
    if (pageNumber < 1 || pageNumber > pdf.numPages) return '';
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent({ includeMarkedContent: false });
    const vp = page.getViewport({ scale: 1 });
    const items = content.items as any[];
    if (isScannedPage(items)) return '';

    const rLeft   = rect.x * vp.width;
    const rRight  = (rect.x + rect.width) * vp.width;
    const rTop    = rect.y * vp.height;
    const rBottom = (rect.y + rect.height) * vp.height;

    type Hit = { x: number; y: number; str: string };
    const hits: Hit[] = [];
    for (const item of items) {
      if (!item.str || !item.transform) continue;
      const str = (item.str as string).trim();
      if (!str) continue;
      const itemX = item.transform[4];
      const itemH = item.height || Math.abs(item.transform[3]) || 12;
      const itemW = item.width || str.length * 6;
      const itemTop = vp.height - item.transform[5];
      const itemBottom = itemTop + itemH;
      const itemCenterY = (itemTop + itemBottom) / 2;
      const xOverlap = Math.min(itemX + itemW, rRight) - Math.max(itemX, rLeft);
      if (itemCenterY < rTop || itemCenterY > rBottom) continue;
      if (itemW <= 0 || xOverlap / itemW < 0.4) continue;
      hits.push({ x: itemX, y: itemTop, str });
    }
    hits.sort((a, b) => {
      if (Math.abs(a.y - b.y) > 6) return a.y - b.y;
      return a.x - b.x;
    });
    return hits.map(h => h.str).join(' ').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

export async function autoSearchFieldValues(
  file: File,
  fieldLabels: { fieldKey: string; label: string }[],
): Promise<Record<number, Highlight[]>> {

  const out: Record<number, Highlight[]> = {};
  if (fieldLabels.length === 0) return out;

  // Same normalizer used by the search bar / findAllTextPositionsInPdfPage.
  const normalize = (s: string) =>
    s.toLowerCase()
     .normalize('NFKD')
     .replace(/\p{M}+/gu, '')
     .replace(/[^a-z0-9 ]/g, ' ')
     .replace(/\s+/g, ' ')
     .trim();

  const isSep = (s: string) => /^[\s:|\-–—•\.]+$/.test(s.trim());

  try {
    const pdf = await getDocumentCached(file);

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      if (pageNum % 10 === 0) await new Promise(r => setTimeout(r, 0));
      const page    = await pdf.getPage(pageNum);
      const content = await page.getTextContent({ includeMarkedContent: false });
      const items   = content.items as any[];
      if (isScannedPage(items)) continue;
      const vp = page.getViewport({ scale: 1 });
      const pageWidth = vp.width, pageHeight = vp.height;

      // ── Build page-level slot map (same as findAllTextPositionsInPdfPage) ──
      // One pass per page; all label searches reuse this.
      type Slot = { item: any; itemW: number; itemH: number; itemTop: number; start: number; end: number; normLen: number };
      const slots: Slot[] = [];
      let pageText = '';
      for (const it of items) {
        if (!it.str || !it.transform) continue;
        const nText = normalize(it.str);
        if (!nText) continue;
        if (pageText.length > 0 && !pageText.endsWith(' ')) pageText += ' ';
        const start  = pageText.length;
        pageText    += nText;
        const end    = pageText.length;
        const itemW  = it.width  || it.str.length * 6;
        const itemH  = it.height || Math.abs(it.transform[3]) || 12;
        const itemTop = pageHeight - it.transform[5] - itemH;
        slots.push({ item: it, itemW, itemH, itemTop, start, end, normLen: end - start });
      }

      // Returns the tight bbox (PDF units) for text matched at [matchIdx, matchEnd).
      function labelBboxPx(matchIdx: number, matchEnd: number) {
        let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
        for (const sl of slots) {
          const oS = Math.max(sl.start, matchIdx);
          const oE = Math.min(sl.end,   matchEnd);
          if (oS >= oE) continue;
          const pS = (oS - sl.start) / sl.normLen;
          const pE = (oE - sl.start) / sl.normLen;
          const x  = sl.item.transform[4];
          left   = Math.min(left,   x + pS * sl.itemW);
          right  = Math.max(right,  x + pE * sl.itemW);
          top    = Math.min(top,    sl.itemTop);
          bottom = Math.max(bottom, sl.itemTop + sl.itemH);
        }
        if (!isFinite(left)) return null;
        return { left, right, top, bottom, height: bottom - top };
      }

      // All items in a band (PDF units): same-line check uses centre-Y.
      function itemsInBand(xMin: number, xMax: number, yMin: number, yMax: number) {
        return items.filter(it => {
          if (!it.str?.trim() || !it.transform) return false;
          const h   = it.height || Math.abs(it.transform[3]) || 12;
          const w   = it.width  || it.str.length * 6;
          const itX = it.transform[4];
          const itTop = pageHeight - it.transform[5] - h;
          const cy  = itTop + h / 2;
          const xOverlap = Math.min(itX + w, xMax) - Math.max(itX, xMin);
          return cy >= yMin && cy <= yMax && w > 0 && xOverlap / w >= 0.25;
        });
      }

      const pageHls: Highlight[] = [];
      const usedFields = new Set<string>();

      for (const { fieldKey, label } of fieldLabels) {
        if (usedFields.has(fieldKey)) continue;
        const q = normalize(label);
        if (!q) continue;

        // ── Search for the label via normalised text ─────────────────────
        const labelIdx = pageText.indexOf(q);
        if (labelIdx === -1) continue;

        const lb = labelBboxPx(labelIdx, labelIdx + q.length);
        if (!lb) continue;

        // ── Collect value items to the right on the same line ────────────
        const sameLineTolerance = lb.height * 0.65;
        const cy = lb.top + lb.height / 2;

        const rightCandidates = itemsInBand(
          lb.right + 1, pageWidth,
          cy - sameLineTolerance, cy + sameLineTolerance,
        ).sort((a: any, b: any) => a.transform[4] - b.transform[4]);

        // Skip leading separators (:  |  —  etc.)
        let fi = 0;
        while (fi < rightCandidates.length && isSep(rightCandidates[fi].str)) fi++;

        let valueItems: any[] = [];

        if (fi < rightCandidates.length) {
          // Build a tight chain: stop on gap > 30px or next-label item (ends with ":")
          const first = rightCandidates[fi];
          const fX   = first.transform[4];
          const fH   = first.height || Math.abs(first.transform[3]) || 12;
          const fTop = pageHeight - first.transform[5] - fH;
          const fCy  = fTop + fH / 2;

          const lineItems = itemsInBand(
            fX - 1, pageWidth,
            fCy - fH * 0.65, fCy + fH * 0.65,
          ).sort((a: any, b: any) => a.transform[4] - b.transform[4]);

          for (const it of lineItems) {
            const itX = it.transform[4];
            if (valueItems.length === 0) { valueItems.push(it); continue; }
            const lastIt  = valueItems[valueItems.length - 1];
            const lastRight = lastIt.transform[4] + (lastIt.width || lastIt.str.length * 6);
            if (itX - lastRight > 30) break;               // column gap
            if (/[:\|]\s*$/.test(it.str.trim())) break;    // next label
            valueItems.push(it);
            if (valueItems.length >= 6) break;
          }
        } else {
          // Nothing to the right — look directly below the label
          const belowItems = itemsInBand(
            lb.left - 5, lb.right + lb.height * 4,
            lb.bottom + 1, lb.bottom + lb.height * 3,
          ).sort((a: any, b: any) => {
            const aT = pageHeight - a.transform[5] - (a.height || 12);
            const bT = pageHeight - b.transform[5] - (b.height || 12);
            return aT - bT;
          });
          if (belowItems[0] && !isSep(belowItems[0].str)) valueItems = [belowItems[0]];
        }

        if (valueItems.length === 0) continue;

        // Compute tight bbox over the value items
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const it of valueItems) {
          const itX = it.transform[4];
          const itW = it.width || it.str.length * 6;
          const itH = it.height || Math.abs(it.transform[3]) || 12;
          const itTop = pageHeight - it.transform[5] - itH;
          minX = Math.min(minX, itX);
          maxX = Math.max(maxX, itX + itW);
          minY = Math.min(minY, itTop);
          maxY = Math.max(maxY, itTop + itH);
        }
        const pad = 2;

        pageHls.push({
          id: `auto-${Date.now()}-${pageNum}-${fieldKey}-${Math.random().toString(36).slice(2, 5)}`,
          page: pageNum,
          field: fieldKey,
          x:      Math.max(0, minX - pad) / pageWidth,
          y:      Math.max(0, minY - pad) / pageHeight,
          width:  (Math.min(pageWidth,  maxX + pad) - Math.max(0, minX - pad)) / pageWidth,
          height: (Math.min(pageHeight, maxY + pad) - Math.max(0, minY - pad)) / pageHeight,
        });
        usedFields.add(fieldKey);
      }

      if (pageHls.length > 0) out[pageNum] = pageHls;
    }
  } catch (err) {
    console.warn('[autoSearchFieldValues] error:', err);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Legacy auto-extract without highlights (kept for backward compat)
// ---------------------------------------------------------------------------
export function autoExtractFields(
  pageTexts: Map<number, string>,
  provider: string,
): ExtractedRow[] {
  const patterns = PROVIDER_PATTERNS[provider] || PROVIDER_PATTERNS['National Grid Gas'];
  const results: ExtractedRow[] = [];
  let lastPropertyName: string | null = null;
  let lastAccountNumber: string | null = null;
  let lastAddress: string | null = null;

  const sortedPages = Array.from(pageTexts.entries()).sort((a, b) => a[0] - b[0]);

  for (const [pageNum, text] of sortedPages) {
    if (!text || text.length < 10) continue;

    const pageResults: Record<string, { value: string | null; confidence: 'high' | 'medium' | 'low' }> = {};

    for (const [field, fieldPatterns] of Object.entries(patterns) as [FieldLabel, RegExp[]][]) {
      let found: string | null = null;
      let confidence: 'high' | 'medium' | 'low' = 'low';

      for (let pi = 0; pi < fieldPatterns.length; pi++) {
        const match = text.match(fieldPatterns[pi]);
        if (match && match[1]) {
          found = match[1].trim();
          confidence = pi <= 1 ? 'high' : 'medium';
          break;
        }
      }
      pageResults[field] = { value: found, confidence };
    }

    if (pageResults.property_name.value) lastPropertyName = pageResults.property_name.value;
    else if (lastPropertyName) pageResults.property_name = { value: lastPropertyName, confidence: 'medium' };

    if (pageResults.account_number.value) lastAccountNumber = pageResults.account_number.value;
    else if (lastAccountNumber) pageResults.account_number = { value: lastAccountNumber, confidence: 'medium' };

    if (pageResults.address.value) lastAddress = pageResults.address.value;
    else if (lastAddress) pageResults.address = { value: lastAddress, confidence: 'medium' };

    for (const [field, result] of Object.entries(pageResults)) {
      if (result.value) {
        results.push({
          page: pageNum,
          field,
          value: result.value,
          confidence: result.confidence,
          wasOcr: false,
        });
      }
    }
  }

  return results;
}