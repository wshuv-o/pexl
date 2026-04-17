/* eslint-disable @typescript-eslint/no-explicit-any */
import { pdfjs } from 'react-pdf';

// ───────────────────────────────────────────────────────────────────────────
// Rule-based auto-matcher. For each Excel header we try to locate a label in
// the PDF text layer (fuzzy) and grab the adjacent value (right of the label
// on the same line, or below it on the next line).
//
// Coordinates are returned as 0..1 fractions of page size, matching how this
// app's Highlight type already works.
// ───────────────────────────────────────────────────────────────────────────

export interface MatchBox {
  page: number;            // 1-indexed page number
  x: number;               // 0..1
  y: number;               // 0..1
  width: number;           // 0..1
  height: number;          // 0..1
  value: string;           // the extracted string
  label: string;           // the matched label text on the PDF (for UX debug)
  score: number;           // 0..1 confidence
}

export interface HeaderMatch {
  header: string;          // the Excel column header this match is for
  box: MatchBox | null;    // null when no plausible match was found
  alternatives: MatchBox[];// additional candidates the user can switch to
}

const normalize = (s: string) =>
  s.toLowerCase()
   .normalize('NFKD')
   .replace(/[\u0300-\u036f]/g, '')
   .replace(/[^a-z0-9\s%$./-]/g, ' ')
   .replace(/\s+/g, ' ')
   .trim();

// Tokenize normalized text into meaningful words (drop very short ones).
const tokens = (s: string) => normalize(s).split(' ').filter(t => t.length >= 2);

// Jaccard overlap on token sets — cheap, works well for short headers.
const similarity = (a: string, b: string): number => {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  A.forEach(t => { if (B.has(t)) inter++; });
  return inter / Math.max(A.size, B.size);
};

// Everything we need to know about one text run on a PDF page.
interface TextItem {
  str: string;
  normStr: string;
  x: number;        // top-left, viewport coords
  y: number;
  width: number;
  height: number;
}

// Extract text items from a page with top-down coordinates.
const extractPageItems = async (
  pdfDoc: any,
  pageNum: number,
): Promise<{ items: TextItem[]; width: number; height: number }> => {
  const page = await pdfDoc.getPage(pageNum);
  const vp = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items: TextItem[] = [];
  for (const it of content.items as any[]) {
    if (!it.str || !it.transform) continue;
    const str = String(it.str);
    const x = it.transform[4];
    const height = it.height || Math.abs(it.transform[3]) || 12;
    const y = vp.height - it.transform[5] - height; // convert baseline → top
    const width = it.width || str.length * 6;
    items.push({
      str,
      normStr: normalize(str),
      x, y, width, height,
    });
  }
  return { items, width: vp.width, height: vp.height };
};

// Are two items roughly on the same text line (centers close in y)?
const sameLine = (a: TextItem, b: TextItem): boolean => {
  const ay = a.y + a.height / 2;
  const by = b.y + b.height / 2;
  return Math.abs(ay - by) <= Math.max(a.height, b.height) * 0.6;
};

// Immediately-below line: b is roughly one line-height under a and
// horizontally overlaps.
const belowLine = (a: TextItem, b: TextItem): boolean => {
  const gap = b.y - (a.y + a.height);
  if (gap < -2 || gap > a.height * 2.2) return false;
  // Some horizontal overlap required
  return b.x < a.x + a.width * 1.2 && b.x + b.width > a.x - 20;
};

// Given a "label" item, find the most likely value item.
// Preference ordering:
//   1. If the label item itself contains "label: value" (inline colon and
//      the remainder is non-empty), synthesise a TextItem for that suffix.
//      Very common — pdfjs frequently emits a label+value pair as a single run.
//   2. First item on the same line AFTER the label (skipping a stray
//      colon/dash separator item if pdfjs split it off on its own).
//   3. First item BELOW the label that horizontally overlaps.
const findValueAfterLabel = (label: TextItem, all: TextItem[]): TextItem | null => {
  // (1) Inline "Label: value" in a single run.
  const colonIdx = label.str.search(/[:\-–—]/);
  if (colonIdx >= 0 && colonIdx < label.str.length - 1) {
    const tail = label.str.slice(colonIdx + 1).trim();
    if (tail) {
      const leadingShare = (colonIdx + 1) / label.str.length;
      return {
        str:     tail,
        normStr: normalize(tail),
        x:       label.x + label.width * leadingShare,
        y:       label.y,
        width:   label.width * (1 - leadingShare),
        height:  label.height,
      };
    }
  }

  // (2) Same-line candidates to the right.
  const right = all
    .filter(it => it !== label && sameLine(label, it) && it.x > label.x + label.width * 0.4)
    .sort((a, b) => a.x - b.x);
  if (right.length > 0) {
    const first = right[0];
    if (/^[:\-–—]$/.test(first.str.trim()) && right.length > 1) return right[1];
    return first;
  }
  // (3) Below candidates.
  const below = all
    .filter(it => it !== label && belowLine(label, it))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  return below[0] ?? null;
};

// Walk all items, compute similarity to `header`, keep the top-N candidates.
const findLabelCandidates = (items: TextItem[], header: string, topN = 4): { item: TextItem; score: number }[] => {
  const candidates: { item: TextItem; score: number }[] = [];
  for (const it of items) {
    if (!it.normStr) continue;
    const score = similarity(header, it.str);
    if (score >= 0.5) candidates.push({ item: it, score });
  }
  // Also try N-gram label matches — pdfjs often splits "Account Number"
  // across two items ("Account" + " " + "Number"). Stitch consecutive
  // same-line items up to 4 tokens long and re-score.
  for (let i = 0; i < items.length; i++) {
    for (let n = 2; n <= 4 && i + n <= items.length; n++) {
      const slice = items.slice(i, i + n);
      if (!slice.every((s, k) => k === 0 || sameLine(slice[k - 1], s))) break;
      const combined = slice.map(s => s.str).join(' ');
      const score = similarity(header, combined);
      if (score < 0.7) continue;
      // Treat the combined span as a single "virtual" label item covering
      // their union bounding box.
      const xs = slice.map(s => s.x);
      const ys = slice.map(s => s.y);
      const xe = slice.map(s => s.x + s.width);
      const ye = slice.map(s => s.y + s.height);
      candidates.push({
        item: {
          str: combined,
          normStr: normalize(combined),
          x: Math.min(...xs),
          y: Math.min(...ys),
          width: Math.max(...xe) - Math.min(...xs),
          height: Math.max(...ye) - Math.min(...ys),
        },
        score: score + 0.05, // small bonus for multi-word exact matches
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, topN);
};

// Build a MatchBox for a detected value item on a given page.
const boxFor = (
  label: TextItem,
  value: TextItem,
  pageNum: number,
  pageW: number,
  pageH: number,
  score: number,
): MatchBox => ({
  page: pageNum,
  x:      value.x / pageW,
  y:      value.y / pageH,
  width:  value.width / pageW,
  height: value.height / pageH,
  value:  value.str.trim(),
  label:  label.str.trim(),
  score,
});

// ───────────────────────────────────────────────────────────────────────────
// Public entry. Loads a PDF, runs label-adjacency matching for every header,
// and returns one HeaderMatch per header (with alternates for UX).
// ───────────────────────────────────────────────────────────────────────────
export const autoMatch = async (
  pdfFile: File,
  headers: string[],
  onProgress?: (pageIdx: number, totalPages: number) => void,
): Promise<HeaderMatch[]> => {
  const buf = await pdfFile.arrayBuffer();
  const pdfDoc = await pdfjs.getDocument({ data: buf }).promise;
  const total = pdfDoc.numPages;

  // Gather candidates per header across all pages.
  const perHeader = new Map<string, MatchBox[]>();
  for (const h of headers) perHeader.set(h, []);

  for (let p = 1; p <= total; p++) {
    onProgress?.(p - 1, total);
    const { items, width: pw, height: ph } = await extractPageItems(pdfDoc, p);
    for (const header of headers) {
      const labels = findLabelCandidates(items, header);
      for (const { item: label, score } of labels) {
        const value = findValueAfterLabel(label, items);
        if (!value) continue;
        const box = boxFor(label, value, p, pw, ph, score);
        perHeader.get(header)!.push(box);
      }
    }
  }
  onProgress?.(total, total);

  // Best-first pick per header; keep the rest as alternatives.
  const result: HeaderMatch[] = [];
  for (const header of headers) {
    const list = (perHeader.get(header) ?? []).sort((a, b) => b.score - a.score);
    result.push({
      header,
      box: list[0] ?? null,
      alternatives: list.slice(1, 6),
    });
  }
  return result;
};
