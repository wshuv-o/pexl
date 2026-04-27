/* eslint-disable no-useless-escape */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { pdfjs } from 'react-pdf';
import type { ExtractedRow, FieldLabel, Highlight } from '@/types/utilscraper';

// Set worker here so pdfjs works in any context (api.ts, pdf-extract.ts)
// not just when PDFViewer is mounted.
if (!pdfjs.GlobalWorkerOptions.workerSrc) {
  pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
}

// ---------------------------------------------------------------------------
// Extract all text from a PDF file, page by page
// ---------------------------------------------------------------------------
export async function extractTextFromPdf(file: File): Promise<Map<number, string>> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
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
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc =
      `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
  }

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  const last = endPage ?? pdf.numPages;
  const out: ValueCandidate[] = [];

  for (let p = startPage; p <= last; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
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
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  const patterns = PROVIDER_PATTERNS[provider] || PROVIDER_PATTERNS['National Grid Gas'];
  const rows: ExtractedRow[] = [];
  const highlights: Record<number, Highlight[]> = {};

  let lastPropertyName: string | null = null;
  let lastAccountNumber: string | null = null;
  let lastAddress: string | null = null;

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
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
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  const results: ExtractedRow[] = [];

  // Group highlights by page so we open each page only once
  const byPage = new Map<number, typeof highlights>();
  for (const h of highlights) {
    if (!byPage.has(h.page)) byPage.set(h.page, []);
    byPage.get(h.page)!.push(h);
  }

  for (const [pageNum, pageHighlights] of byPage.entries()) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1 });
    const pageWidth = viewport.width;
    const pageHeight = viewport.height;

    const items = content.items as any[];
    const scanned = isScannedPage(items);

    for (const hl of pageHighlights) {
      // If the page is scanned, pdfjs has no text — signal that OCR is needed
      if (scanned) {
        results.push({
          page: hl.page,
          field: hl.field,
          value: null,
          confidence: 'low',
          wasOcr: true,    // ← tells the caller "retry this with the backend OCR"
        });
        continue;
      }

      // Exact highlight rect in PDF points — no padding.
      // Padding was pulling in text from neighboring rows/columns.
      const hlLeft   = hl.x * pageWidth;
      const hlRight  = (hl.x + hl.width)  * pageWidth;
      const hlTop    = hl.y * pageHeight;
      const hlBottom = (hl.y + hl.height) * pageHeight;

      // Collect matched items with their positions
      const matchedItems: { x: number; y: number; str: string }[] = [];

      for (const item of items) {
        if (!item.str || !item.transform) continue;
        const str = item.str;
        if (!str.trim()) continue;
        // Skip items that are purely binary-encoded hidden numbers
        if (/^[01]{8,}$/.test(str.trim())) continue;

        const bb = itemAABB(item, pageHeight);

        // Row filter: center-Y must be inside highlight (prevents above/below row bleed)
        const inRow = bb.centerY >= hlTop && bb.centerY <= hlBottom;

        // Column filter: at least 40% of item width must overlap highlight horizontally
        const xOverlap = Math.min(bb.right, hlRight) - Math.max(bb.left, hlLeft);
        const inCol = bb.width > 0 && (xOverlap / bb.width) >= 0.4;

        if (inRow && inCol) {
          matchedItems.push({ x: bb.left, y: bb.top, str });
        }
      }

      const deduped: typeof matchedItems = [];
      for (const item of matchedItems) {
        const isDup = deduped.some(
          d => d.str === item.str && Math.abs(d.x - item.x) < 4 && Math.abs(d.y - item.y) < 4
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
        const firstY = deduped[0].y;
        const firstLine = deduped.filter(i => Math.abs(i.y - firstY) <= 6);
        const restLine  = deduped.filter(i => Math.abs(i.y - firstY) > 6);
        if (restLine.length > 0) {
          const firstLineText = firstLine.map(i => i.str).join('').trim();
          if (firstLineText.length >= 3) {
            finalItems = firstLine;
          }
        }
      }

      const rawJoined = finalItems.map(i => i.str).join(' ');
      const value = rawJoined
        .replace(/\(\d+\)/g, '')   // strip (numeric) groups
        .replace(/[()]/g, '')       // strip any lone brackets
        .replace(/[^\p{L}\p{N}\p{P}\p{Z}\p{Sc}\p{Sm}]/gu, '') // strip emoji & decorative symbols, keep letters/numbers/punctuation/spaces/currency/math
        .replace(/\b[01]{8,}\b/g, '')  // strip binary-encoded hidden numbers (8+ digits of only 0/1)
        .replace(/\s+/g, ' ')
        .trim() || null;

      results.push({
        page:       hl.page,
        field:      hl.field,
        value,
        confidence: value && value.length > 2 ? 'high' : value ? 'medium' : 'low',
        wasOcr:     false,
      });
    }
  }

  return results;
}

export async function findTextPositionInPdf(
  file: File,
  pageNumber: number,
  searchText: string,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  if (!searchText || !searchText.trim()) return null;
  // Ensure worker is set before every call — not just module load time
  pdfjs.GlobalWorkerOptions.workerSrc =
    `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

  try {
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjs.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;

    if (pageNumber < 1 || pageNumber > pdf.numPages) return null;

    const page    = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const vp      = page.getViewport({ scale: 1 });

    if (isScannedPage(content.items as any[])) return null;

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
  pdfjs.GlobalWorkerOptions.workerSrc =
    `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdf  = await pdfjs.getDocument({ data: arrayBuffer }).promise;
    if (pageNumber < 1 || pageNumber > pdf.numPages) return '';
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
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
  pdfjs.GlobalWorkerOptions.workerSrc =
    `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

  const out: Record<number, Highlight[]> = {};
  if (fieldLabels.length === 0) return out;

  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      const items = content.items as any[];
      if (isScannedPage(items)) continue;
      const vp = page.getViewport({ scale: 1 });
      const pageWidth = vp.width, pageHeight = vp.height;

      // Convert to a richer representation we can do spatial queries on.
      type Item = { str: string; x: number; y: number; w: number; h: number; cy: number };
      const enriched: Item[] = [];
      for (const it of items) {
        if (!it.str || !it.transform) continue;
        const s = String(it.str);
        if (!s.trim()) continue;
        const x = it.transform[4];
        const h = it.height || Math.abs(it.transform[3]) || 12;
        const w = it.width  || s.length * 6;
        const top = pageHeight - it.transform[5];
        enriched.push({ str: s, x, y: top, w, h, cy: top + h / 2 });
      }

      const pageHls: Highlight[] = [];
      const usedFields = new Set<string>();

      for (const { fieldKey, label } of fieldLabels) {
        if (usedFields.has(fieldKey)) continue;
        const needle = label.toLowerCase();

        let hit: Item | null = null;
        for (let i = 0; i < enriched.length; i++) {
          const it = enriched[i];
          if (it.str.toLowerCase().includes(needle)) {
            hit = it;
            break;
          }
          // Try joining 2-4 items on the same line
          for (let n = 2; n <= 4 && i + n <= enriched.length; n++) {
            const joined = enriched.slice(i, i + n);
            const sameLine = joined.every(j => Math.abs(j.cy - joined[0].cy) < 4);
            if (!sameLine) continue;
            const combined = joined.map(j => j.str).join(' ').toLowerCase().replace(/\s+/g, ' ');
            if (combined.includes(needle)) {
              hit = joined[joined.length - 1];     // anchor on the LAST item so we look to its right
              break;
            }
          }
          if (hit) break;
        }
        if (!hit) continue;

        const labelRight = hit.x + hit.w;
        const sameLine = enriched
          .filter(it => it !== hit && Math.abs(it.cy - hit.cy) < 6 && it.x >= labelRight - 1)
          .sort((a, b) => a.x - b.x);

        let value: Item | null = sameLine[0] ?? null;
        if (!value) {
          // Look below — first line that has an item under the label's horizontal span
          const below = enriched
            .filter(it => it.y > hit.y + hit.h - 1 && it.y < hit.y + hit.h + 60)
            .sort((a, b) => a.y - b.y || Math.abs(a.x - hit.x) - Math.abs(b.x - hit.x));
          value = below[0] ?? null;
        }
        if (!value) continue;

        const sameLineAll = enriched
          .filter(it => Math.abs(it.cy - value!.cy) < 4 && it.x >= value!.x - 1)
          .sort((a, b) => a.x - b.x);
        const chain: Item[] = [];
        for (const it of sameLineAll) {
          if (chain.length === 0) { chain.push(it); continue; }
          const last = chain[chain.length - 1];
          const gap = it.x - (last.x + last.w);
          if (gap > 20) break;                 // too far — different value
          chain.push(it);
          if (chain.length >= 5) break;        // cap
        }
        const minX = Math.min(...chain.map(c => c.x));
        const maxX = Math.max(...chain.map(c => c.x + c.w));
        const minY = Math.min(...chain.map(c => c.y));
        const maxY = Math.max(...chain.map(c => c.y + c.h));
        const pad = 2;

        // Leave extractedValue / confidence / wasOcr UNSET and isAutoExtracted
        // off — the caller (handleAutoSearch) kicks off the regular Extract
        // flow right after, which runs the backend's smart detection over
        // these boxes and produces canonical values. Treating them as fresh
        // user-drawn highlights gives us the same accuracy as manual draws.
        pageHls.push({
          id: `auto-${Date.now()}-${pageNum}-${fieldKey}-${Math.random().toString(36).slice(2, 5)}`,
          page: pageNum,
          field: fieldKey,
          x:      Math.max(0, minX - pad) / pageWidth,
          y:      Math.max(0, minY - pad) / pageHeight,
          width:  (Math.min(pageWidth,  maxX + pad) - Math.max(0, minX - pad)) / pageWidth,
          height: (Math.min(pageHeight, maxY + pad) - Math.max(0, minY - pad)) / pageHeight,
        });
        usedFields.add(fieldKey);              // don't double-match the same field on this page
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