// Pure date normalisation shared by extraction (api.ts) and the Excel
// exporters. Kept free of browser/Vite imports so the server-side export
// runtime (src/server/export-cli.ts) can bundle it.

const MONTH_MAP: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7,
  aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

// Longest names first so "sept" wins over "sep" in alternation.
const MONTH_ALT = Object.keys(MONTH_MAP).sort((a, b) => b.length - a.length).join('|');

const expandYear = (y: number): number => (y < 100 ? (y < 70 ? 2000 + y : 1900 + y) : y);

const isValidDate = (m: number, d: number, y: number): boolean => {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
};

const fmtMDY = (m: number, d: number, y: number): string =>
  `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${String(y).padStart(4, '0')}`;

// Find the FIRST complete date (day + month + year) in the string and return
// it as MM/DD/YYYY. Search-based, not anchored: once a date ending in a year
// is found, everything after it is ignored — so statement-period ranges like
// "Nov 11, 2025 - Dec 10, 2025" (any separator, spaced or not) yield only the
// start date. Two-digit years expand ("Nov 11 26" → 11/11/2026).
function findFirstDate(s: string): string | null {
  const cands: { index: number; fmt: () => string | null }[] = [];

  // Month D [YY]YY — "Nov 11 2026", "nov 11 26", "September 5 2025"
  const mdy = s.match(new RegExp(`\\b(${MONTH_ALT})\\.?\\s+(\\d{1,2})\\s+((?:19|20)\\d{2}|\\d{2})\\b`, 'i'));
  if (mdy && mdy.index !== undefined) {
    const [, mon, dd, yy] = mdy;
    cands.push({ index: mdy.index, fmt: () => {
      const m = MONTH_MAP[mon.toLowerCase()];
      const d = parseInt(dd, 10), y = expandYear(parseInt(yy, 10));
      return m && isValidDate(m, d, y) ? fmtMDY(m, d, y) : null;
    }});
  }

  // D Month [YY]YY — "11 Nov 2026", "15 Jan 22"
  const dmy = s.match(new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_ALT})\\.?\\s+((?:19|20)\\d{2}|\\d{2})\\b`, 'i'));
  if (dmy && dmy.index !== undefined) {
    const [, dd, mon, yy] = dmy;
    cands.push({ index: dmy.index, fmt: () => {
      const m = MONTH_MAP[mon.toLowerCase()];
      const d = parseInt(dd, 10), y = expandYear(parseInt(yy, 10));
      return m && isValidDate(m, d, y) ? fmtMDY(m, d, y) : null;
    }});
  }

  // ISO YYYY-MM-DD
  const iso = s.match(/\b((?:19|20)\d{2})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{1,2})\b/);
  if (iso && iso.index !== undefined) {
    const [, yy, mm, dd] = iso;
    cands.push({ index: iso.index, fmt: () => {
      const y = parseInt(yy, 10), m = parseInt(mm, 10), d = parseInt(dd, 10);
      return isValidDate(m, d, y) ? fmtMDY(m, d, y) : null;
    }});
  }

  // Numeric M/D/[YY]YY (falls back to D/M when M/D is invalid)
  const num = s.match(/\b(\d{1,2})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*((?:19|20)\d{2}|\d{2})\b/);
  if (num && num.index !== undefined) {
    const [, aa, bb, yy] = num;
    cands.push({ index: num.index, fmt: () => {
      const a = parseInt(aa, 10), b = parseInt(bb, 10), y = expandYear(parseInt(yy, 10));
      if (isValidDate(a, b, y)) return fmtMDY(a, b, y);
      if (isValidDate(b, a, y)) return fmtMDY(b, a, y);
      return null;
    }});
  }

  cands.sort((a, b) => a.index - b.index);
  for (const c of cands) {
    const r = c.fmt();
    if (r) return r;
  }
  return null;
}

export function normalizeDateValue(raw: string, opts: { takeEnd?: boolean } = {}): string {
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

  // --- Range handling. Default keeps the START date; opts.takeEnd keeps the
  // END date instead (utility billing_date wants the close of the period,
  // mirroring the backend's take_end). Whichever half is kept borrows a
  // 4-digit year from the other half when it has none ("Dec 11 - Jan 13,
  // 2025" → "Dec 11 2025").
  {
    const seps = [' to ', ' through ', ' thru ', ' - ', ' – ', ' — ', '—', '–'];
    const lower = s.toLowerCase();
    if (opts.takeEnd) {
      let lastIdx = -1, lastLen = 0;
      for (const sep of seps) {
        const i = lower.lastIndexOf(sep);
        if (i > lastIdx) { lastIdx = i; lastLen = sep.length; }
      }
      if (lastIdx >= 0) {
        let end = s.slice(lastIdx + lastLen).trim();
        const before = s.slice(0, lastIdx);
        if (!/(?:19|20)\d{2}/.test(end)) {
          const y = before.match(/\b((?:19|20)\d{2})\b/);
          if (y) end = `${end} ${y[1]}`;
        }
        if (end) s = end;
      }
    } else {
      for (const sep of seps) {
        const idx = lower.indexOf(sep);
        if (idx > 0) {
          let start = s.slice(0, idx).trim();
          const rest = s.slice(idx + sep.length);
          if (!/(?:19|20)\d{2}/.test(start)) {
            const y = rest.match(/\b((?:19|20)\d{2})\b/);
            if (y) start = `${start} ${y[1]}`;
          }
          s = start;
          break;
        }
      }
    }
  }

  // --- Normalise whitespace ---
  s = s.replace(/[,]+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();

  // --- First complete date wins; anything after it is discarded ---
  const first = findFirstDate(s);
  if (first) return first;

  // Month + year only, e.g. "September 2025" → first of the month
  const patC = s.match(/^([a-zA-Z]+)\s+(\d{4})$/);
  if (patC) {
    const month = MONTH_MAP[patC[1].toLowerCase()];
    if (month) {
      return `${String(month).padStart(2, '0')}/01/${patC[2]}`;
    }
  }

  return s;
}
