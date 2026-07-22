"""Extract a date from messy OCR text and return MM/DD/YYYY or 'NONE'."""

import re
from datetime import datetime

MONTHS = {
    "january": 1, "february": 2, "march": 3, "april": 4,
    "may": 5, "june": 6, "july": 7, "august": 8,
    "september": 9, "october": 10, "november": 11, "december": 12,
    "jan": 1, "feb": 2, "mar": 3, "apr": 4,
    "jun": 6, "jul": 7, "aug": 8, "sep": 9, "sept": 9,
    "oct": 10, "nov": 11, "dec": 12,
}

ORDINAL_RE = re.compile(r"(\d{1,2})\s*(?:st|nd|rd|th)\b", re.IGNORECASE)


def _fix_ocr(text: str) -> str:
    """Fix common OCR character substitutions in numeric contexts."""
    # Replace letter O with 0 and lowercase l with 1 when surrounded by digits/separators
    out = []
    for i, ch in enumerate(text):
        prev = text[i - 1] if i > 0 else ""
        nxt = text[i + 1] if i < len(text) - 1 else ""
        is_numeric_ctx = (prev.isdigit() or prev in "/-.") or (nxt.isdigit() or nxt in "/-.")
        if ch in "Oo" and is_numeric_ctx:
            out.append("0")
        elif ch == "l" and is_numeric_ctx:
            out.append("1")
        else:
            out.append(ch)
    return "".join(out)


def _strip_label(text: str) -> str:
    """Remove common label prefixes."""
    label_re = re.compile(
        r"^(?:billing\s*period|date\s*bill\s*issued|statement\s*date|invoice\s*date"
        r"|due\s*date|service\s*(?:from|to)|bill\s*date|date)\s*[:\-]?\s*",
        re.IGNORECASE,
    )
    return label_re.sub("", text).strip()


def _strip_inline_label(text: str) -> str:
    """Strip an arbitrary ``<label>: `` prefix when the user's highlight
    accidentally grabbed it along with the date.

    Examples:
      • ``Something: Jan 15 2025`` → ``Jan 15 2025``
      • ``Period: Dec 11 2024 - Jan 13 2025`` → ``Dec 11 2024 - Jan 13 2025``
      • ``Foo / Bar Date : 15-Jan-2022`` → ``15-Jan-2022``

    Skips time patterns: ``12:30 PM Jan 15 2025`` is left untouched because
    the colon is preceded by digits (negative lookbehind ``(?<!\\d)``).
    Falls back to the original ``_strip_label`` for the curated list.
    """
    # Find the LEFTMOST colon that's not part of a time (digit:digit) pattern.
    m = re.search(r"(?<!\d):\s*", text)
    if not m:
        return text
    rest = text[m.end():].strip()
    # Sanity check: the part after the colon should still look date-ish
    # (a year, or a month name). Otherwise we'd happily strip random
    # alpha-prefixed colons in non-date contexts.
    if rest and (
        re.search(r"\b(?:19|20)\d{2}\b", rest)
        or any(re.search(rf"\b{mon}\b", rest, re.IGNORECASE) for mon in MONTHS)
        or re.search(r"\b\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}\b", rest)
    ):
        return rest
    return text


_RANGE_SEPS = [" to ", " through ", " thru ", " - ", " – ", " — ", "—", "–"]


def _take_start_date(text: str) -> str:
    """If a range is present, return only the part before the range separator.
    If the start portion has no year, borrow it from the end portion."""
    for sep in _RANGE_SEPS:
        if sep in text.lower():
            idx = text.lower().index(sep)
            start = text[:idx].strip()
            rest = text[idx + len(sep):].strip()
            # If start has no 4-digit year, grab one from the end portion
            if not re.search(r"\b(?:19|20)\d{2}\b", start):
                year_match = re.search(r"\b((?:19|20)\d{2})\b", rest)
                if year_match:
                    start = start + " " + year_match.group(1)
            return start
    return text


def _take_end_date(text: str) -> str:
    """If a range is present, return only the part after the *last* range
    separator. If the end portion has no year, borrow it from the start
    portion.

    Used for fields where the trailing date is the meaningful one — e.g.
    a utility ``billing_date`` printed as ``Dec 11 2024 - Jan 13 2025`` is
    the period the bill covers, and the user wants the close-of-period
    (``01/13/2025``) as the date of record.
    """
    lower = text.lower()
    last_idx = -1
    last_sep_len = 0
    for sep in _RANGE_SEPS:
        i = lower.rfind(sep)
        if i > last_idx:
            last_idx = i
            last_sep_len = len(sep)
    if last_idx < 0:
        return text
    end = text[last_idx + last_sep_len:].strip()
    start = text[:last_idx].strip()
    if not re.search(r"\b(?:19|20)\d{2}\b", end):
        year_match = re.search(r"\b((?:19|20)\d{2})\b", start)
        if year_match:
            end = end + " " + year_match.group(1)
    return end


_MONTH_ALT = "|".join(sorted(MONTHS, key=len, reverse=True))

# A "complete" date substring — month-name, numeric, or ISO, with a 4- or
# 2-digit year. Used to cut the text at the FIRST full date so a range end
# ("... - Dec 10, 2025"), an unspaced range separator ("11/01/2025-11/30/2025"),
# or trailing clutter never leaks into the extracted value.
_FIRST_DATE_PATTERNS = [
    # Month D[,] YYYY|YY   e.g. "Nov 11, 2026", "nov 11,26", "November 11 2026"
    re.compile(
        rf"\b(?:{_MONTH_ALT})\.?\s+\d{{1,2}}(?:st|nd|rd|th)?\s*[,.]?\s*(?:(?:19|20)\d{{2}}|\d{{2}})\b",
        re.IGNORECASE,
    ),
    # D Month[,] YYYY|YY   e.g. "11 Nov 2026", "15-Jan-2022"
    re.compile(
        rf"\b\d{{1,2}}(?:st|nd|rd|th)?[\s\-]+(?:{_MONTH_ALT})\.?[\s\-,.]*(?:(?:19|20)\d{{2}}|\d{{2}})\b",
        re.IGNORECASE,
    ),
    # Numeric M/D/YYYY, M-D-YY, M.D.YYYY
    re.compile(r"\b\d{1,2}[/\-.]\d{1,2}[/\-.](?:(?:19|20)\d{2}|\d{2})\b"),
    # ISO YYYY-MM-DD
    re.compile(r"\b(?:19|20)\d{2}[/\-.]\d{1,2}[/\-.]\d{1,2}\b"),
]


def _truncate_after_first_date(text: str) -> str:
    """Cut the text down to its FIRST complete date.

    Once one full date (day + month + year) is found, everything after it is
    ignored — so a highlighted statement period like
    "Nov 11, 2025 - Dec 10, 2025" yields just "Nov 11, 2025" no matter what
    separator the bank used. Text with no complete date passes through
    unchanged (the caller's parsers then get the whole string as before).
    """
    best = None
    for rx in _FIRST_DATE_PATTERNS:
        m = rx.search(text)
        if m is not None and (best is None or m.start() < best.start()):
            best = m
    return best.group(0) if best else text


def _normalize_extra_spaces(text: str) -> str:
    """Fix OCR artifacts like 'Jan 9 ,2025' → 'Jan 9, 2025'."""
    text = re.sub(r"\s+,", ",", text)       # space before comma
    text = re.sub(r",(\S)", r", \1", text)   # missing space after comma
    # "Jan 9. 2025" → period used as comma (OCR artifact after day number before year)
    text = re.sub(r"(\b\d{1,2})\.\s+(\d{4})\b", r"\1, \2", text)
    return text


def _month_name_to_num(name: str) -> int | None:
    return MONTHS.get(name.lower())


def _fmt(m: int, d: int, y: int) -> str:
    return f"{m:02d}/{d:02d}/{y:04d}"


def _expand_year(y: int) -> int:
    if y < 100:
        return 2000 + y if y < 70 else 1900 + y
    return y


def _valid(m: int, d: int, y: int) -> bool:
    try:
        datetime(y, m, d)
        return True
    except (ValueError, OverflowError):
        return False


def _try_month_name_formats(text: str) -> str | None:
    """Handle all month-name based formats."""
    # Strip ordinals: "5th" → "5"
    cleaned = ORDINAL_RE.sub(r"\1", text)
    # Remove filler words
    cleaned = re.sub(r"\b(?:the|day|of)\b", " ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    cleaned = re.sub(r"[,\-]", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()

    # Remove time portions
    cleaned = re.sub(r"\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?", "", cleaned, flags=re.IGNORECASE).strip()

    tokens = cleaned.split()

    # Try: MonthName Day Year
    for i, tok in enumerate(tokens):
        mn = _month_name_to_num(tok)
        if mn is None:
            continue
        # Look for day and year after or before month
        remaining = tokens[:i] + tokens[i + 1:]
        nums = [t for t in remaining if t.isdigit()]
        if len(nums) >= 2:
            a, b = int(nums[0]), int(nums[1])
            if a > 31:  # year first: Year Month Day
                y, d = a, b
            elif b > 31:  # day then year
                d, y = a, b
            elif a <= 31 and b <= 31:
                # Ambiguous — assume first is day
                d, y = a, b
            else:
                continue
            y = _expand_year(y)
            if _valid(mn, d, y):
                return _fmt(mn, d, y)
        elif len(nums) == 1:
            # Only one number — could be day (year missing from range context)
            continue

    return None


def _try_numeric_formats(text: str) -> str | None:
    """Handle all numeric date formats."""
    # Remove time portions
    cleaned = re.sub(r"\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:AM|PM))?", "", text, flags=re.IGNORECASE).strip()

    # YYYYMMDD (8 digits, no separators)
    m = re.search(r"\b((?:19|20)\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\b", cleaned)
    if m:
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if _valid(mo, d, y):
            return _fmt(mo, d, y)

    # MMDDYYYY (8 digits, no separators)
    m = re.search(r"\b(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])((?:19|20)\d{2})\b", cleaned)
    if m:
        mo, d, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if _valid(mo, d, y):
            return _fmt(mo, d, y)

    # YYYY/MM/DD or YYYY-MM-DD or YYYY.MM.DD
    m = re.search(r"((?:19|20)\d{2})[/\-.](\d{1,2})[/\-.](\d{1,2})", cleaned)
    if m:
        y, a, b = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if _valid(a, b, y):
            return _fmt(a, b, y)

    # MM/DD/YYYY, MM-DD-YYYY, MM.DD.YYYY, DD/MM/YYYY etc.
    m = re.search(r"(\d{1,2})[/\-.\s](\d{1,2})[/\-.\s](\d{2,4})", cleaned)
    if m:
        a, b, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        y = _expand_year(y)
        # Try MM/DD/YYYY first (US convention)
        if _valid(a, b, y):
            return _fmt(a, b, y)
        # Try DD/MM/YYYY
        if _valid(b, a, y):
            return _fmt(b, a, y)

    return None


def extract_date(text: str, take_end: bool = False) -> str:
    """Extract a date from text and return MM/DD/YYYY, or 'NONE'.

    ``take_end=True`` selects the trailing date of a range — used for
    ``billing_date`` on utility bills where the period is printed as
    ``Dec 11 2024 - Jan 13 2025`` and the close-of-period is the date
    of record.
    """
    if not text or not text.strip():
        return "NONE"

    text = text.strip()
    text = _fix_ocr(text)
    text = _normalize_extra_spaces(text)
    text = _strip_label(text)
    # Catches arbitrary `<label>: <date>` patterns the curated list misses.
    text = _strip_inline_label(text)
    text = _take_end_date(text) if take_end else _take_start_date(text)
    if not take_end:
        # Ranges with unspaced separators ("11/01/2025-11/30/2025") survive
        # _take_start_date; keeping only the first complete date fixes those
        # and drops any trailing clutter after the date.
        text = _truncate_after_first_date(text)
    text = text.strip()

    if not text:
        return "NONE"

    # Try month name formats first (less ambiguous)
    result = _try_month_name_formats(text)
    if result:
        return result

    # Try numeric formats
    result = _try_numeric_formats(text)
    if result:
        return result

    return "NONE"
