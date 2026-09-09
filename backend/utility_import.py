"""Import an externally-generated utility Excel straight into the database.

Two sheet layouts are understood:

**Long** — one row per property x utility x billing period, the utility named
in its own column and the money in a single charges column::

    Property Name | Provider Name | Account | Service Start Date |
    Service End Date | Current Charges | Utility Type

**Wide** — one row per invoice, one column per utility type::

    Property Name | Provider | Account Number | Invoice Date |
    Electricity | Gas | Trash | Water

A wide row becomes ONE record carrying a ``total_*_bill`` field per filled
utility column, which is exactly what the utility-template exporter groups
on, so no fan-out is needed.

Formulas are preserved. A cell holding ``=1.2+2.3+4.5`` stores both the
computed total AND the literal expression, in a sibling ``*_expr`` field;
the exporter re-emits that expression as the formula of the month cell it
lands in, so the arithmetic survives into the generated report instead of
being flattened to a single number. Only literal arithmetic is carried
over — a formula referencing other cells (``=B2+C2``) or calling a function
(``=SUM(...)``) would be meaningless in the output workbook, so those keep
their computed value and drop the expression.

This module parses the sheet, maps its columns onto the field names the rest
of the app (and the utility-template exporter) expects, creates a batch, and
bulk-inserts every row as a batch_record. No OCR, no PDF — the data is
trusted as-is.
"""

import ast
import io
import logging
import operator
import re
import uuid

from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import JSONResponse

import batch_service as bs

logger = logging.getLogger(__name__)
router = APIRouter()


# ---------------------------------------------------------------------------
# Column-header mapping (case/space/punctuation-insensitive)
# ---------------------------------------------------------------------------

def _norm(h: str) -> str:
    return "".join(ch for ch in str(h or "").lower() if ch.isalnum())


# normalized header -> canonical field name
_HEADER_MAP = {
    "propertyname": "property_name",
    "property": "property_name",
    "providername": "provider_name",
    "provider": "provider_name",
    "account": "account_number",
    "accountnumber": "account_number",
    "accountno": "account_number",
    "acct": "account_number",
    "serviceenddate": "service_end_date",
    "billingenddate": "service_end_date",
    "enddate": "service_end_date",
    "servicestartdate": "service_start_date",
    "billingstartdate": "service_start_date",
    "startdate": "service_start_date",
    "currentcharges": "amount",
    "amount": "amount",
    "charges": "amount",
    "totalamount": "amount",
    "utilitytype": "utility_type",
    "type": "utility_type",
    "utility": "utility_type",
    "address": "address",
    # Invoice-style dates land on 'date', NOT 'billing_date'. The exporter
    # buckets 'billing_date' into the *previous* month when the day is
    # before the 15th (utility bills cover the period before issue), which
    # would push an invoice dated 2026-05-01 into Apr-26. 'date' is taken
    # at face value, so the month the invoice names is the month it lands in.
    "invoicedate": "date",
    "invoiceddate": "date",
    "billdate": "date",
    "statementdate": "date",
    "date": "date",
}

# Utility type -> the total_* field the template groups on. Doubles as the
# recognizer for wide-layout amount columns, so a column headed "Trash" is
# understood as trash money without a Utility Type column in the sheet.
_UTILITY_FIELD = {
    "electricity": "total_electricity_bill",
    "electric": "total_electricity_bill",
    "gas": "total_gas_bill",
    "water": "total_water_bill",
    "sewer": "total_sewer_bill",
    "watersewer": "total_water_sewer_bill",
    "waterandsewer": "total_water_sewer_bill",
    "internet": "total_internet_bill",
    "phone": "total_phone_bill",
    "trash": "total_trash_bill",
}

# Money cells accept $ signs, thousands separators and (parenthesised)
# negatives for credits.
_MONEY_STRIP = re.compile(r"[$,\s]")
# A retainable expression is literal arithmetic only — digits, operators,
# parens, decimal points. Anything else (cell refs, function calls, string
# concatenation) is computed but not carried into the output workbook.
_LITERAL_ARITH = re.compile(r"^[0-9.+\-*/()\s]+$")
_HAS_OPERATOR = re.compile(r"[+\-*/]")

_ARITH_OPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
}


def _to_str(v) -> str:
    if v is None:
        return ""
    # openpyxl gives datetimes for date cells — render as ISO date.
    if hasattr(v, "isoformat"):
        try:
            return v.date().isoformat() if hasattr(v, "date") else v.isoformat()
        except Exception:
            return str(v)
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v).strip()


def _eval_arith(expr: str):
    """Evaluate a literal arithmetic string, or return None.

    Uses an ast walk with a four-operator allow-list rather than eval() —
    the input is a spreadsheet cell, so it is untrusted.
    """
    try:
        node = ast.parse(expr, mode="eval").body
    except Exception:
        return None

    def ev(n):
        if isinstance(n, ast.Constant):
            if isinstance(n.value, bool) or not isinstance(n.value, (int, float)):
                return None
            return float(n.value)
        if isinstance(n, ast.UnaryOp) and isinstance(n.op, (ast.UAdd, ast.USub)):
            v = ev(n.operand)
            if v is None:
                return None
            return v if isinstance(n.op, ast.UAdd) else -v
        if isinstance(n, ast.BinOp) and type(n.op) in _ARITH_OPS:
            a, b = ev(n.left), ev(n.right)
            if a is None or b is None:
                return None
            try:
                return _ARITH_OPS[type(n.op)](a, b)
            except ZeroDivisionError:
                return None
        return None

    return ev(node)


def _parse_money(v):
    """Coerce a cell value to a float, or None if it isn't money."""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = _MONEY_STRIP.sub("", str(v))
    if not s:
        return None
    neg = s.startswith("(") and s.endswith(")")
    if neg:
        s = s[1:-1]
    try:
        n = float(s)
    except ValueError:
        return None
    return -n if neg else n


def _retainable_expr(formula) -> str:
    """Return the literal-arithmetic body of a formula worth retaining, else ''.

    ``=1.2+2.3`` -> ``1.2+2.3``.  ``=B2+C2``, ``=SUM(A1:A9)``, ``=1151.39``
    (no operator, nothing to retain) -> ``''``.
    """
    if not isinstance(formula, str) or not formula.startswith("="):
        return ""
    body = formula[1:].strip()
    if not body or not _LITERAL_ARITH.match(body):
        return ""
    body = re.sub(r"\s+", "", body)
    if not _HAS_OPERATOR.search(body) or not any(ch.isdigit() for ch in body):
        return ""
    # Must actually evaluate — a malformed body is not worth writing into
    # the output workbook, where Excel would flag it as an error.
    return body if _eval_arith(body) is not None else ""


def _read_amount(value_cell, formula_cell):
    """Resolve one money cell to ``(amount, expr)``.

    ``value_cell`` comes from the data_only pass (Excel's cached result),
    ``formula_cell`` from the formula pass. Either may be missing: a
    workbook written by a tool rather than by Excel carries no cached
    values at all, in which case the expression is evaluated here.
    """
    expr = _retainable_expr(formula_cell)
    amount = _parse_money(value_cell)
    if amount is None and expr:
        amount = _eval_arith(expr)
    if amount is None and isinstance(formula_cell, str) and not formula_cell.startswith("="):
        amount = _parse_money(formula_cell)
    if amount is None:
        return None, ""
    if expr:
        # Guarantee the invariant every downstream consumer relies on: the
        # retained expression evaluates to the stored amount. Checked here,
        # where the evaluator lives, so the exporter can write the
        # expression into a cell without re-deriving the arithmetic. A
        # disagreement means Excel's cached value was computed from
        # something we didn't parse — keep the value, drop the expression.
        check = _eval_arith(expr)
        if check is None or abs(check - amount) > 0.005:
            expr = ""
    return amount, expr


def _fmt_amount(n: float) -> str:
    return f"{n:.2f}"


def _parse_rows(file_bytes: bytes):
    """Yield mapped field-dicts from the first worksheet.

    Returns (rows, headers, skipped_blank, skipped_no_amount, unmapped).
    """
    import openpyxl

    # Two passes over the same bytes: cached values, then formula text.
    # read_only keeps a 50k-row sheet from being held in memory twice over.
    wb_val = openpyxl.load_workbook(io.BytesIO(file_bytes), read_only=True, data_only=True)
    wb_fml = openpyxl.load_workbook(io.BytesIO(file_bytes), read_only=True, data_only=False)
    ws_val = wb_val[wb_val.sheetnames[0]]
    ws_fml = wb_fml[wb_fml.sheetnames[0]]

    rows = []
    headers = None
    unmapped = []
    col_field = {}     # column index -> canonical field (long layout)
    col_utility = {}   # column index -> total_*_bill field (wide layout)
    skipped_blank = 0
    skipped_no_amount = 0

    val_iter = ws_val.iter_rows(values_only=True)
    fml_iter = ws_fml.iter_rows(values_only=True)

    for raw, raw_fml in zip(val_iter, fml_iter):
        if headers is None:
            headers = [_to_str(c) for c in raw]
            for c_i, h in enumerate(raw):
                key = _norm(h)
                if not key:
                    continue
                # Named fields win over utility columns so a sheet with a
                # "Utility" type column keeps its long-layout meaning.
                if key in _HEADER_MAP:
                    col_field[c_i] = _HEADER_MAP[key]
                elif key in _UTILITY_FIELD:
                    col_utility[c_i] = _UTILITY_FIELD[key]
                else:
                    unmapped.append(_to_str(h))
            continue

        vals = {}
        has_money = False

        for c_i, cell in enumerate(raw):
            cell_fml = raw_fml[c_i] if c_i < len(raw_fml) else None

            # Wide layout: the header names the utility, the cell is money.
            util_field = col_utility.get(c_i)
            if util_field:
                amount, expr = _read_amount(cell, cell_fml)
                if amount is not None:
                    vals[util_field] = _fmt_amount(amount)
                    if expr:
                        vals[util_field + "_expr"] = expr
                    has_money = True
                continue

            field = col_field.get(c_i)
            if not field:
                continue

            if field == "amount":
                amount, expr = _read_amount(cell, cell_fml)
                if amount is not None:
                    vals["amount"] = _fmt_amount(amount)
                    if expr:
                        vals["amount_expr"] = expr
                    has_money = True
                continue

            s = _to_str(cell)
            if s:
                vals[field] = s

        # Drop fully blank rows (the file has trailing empties).
        if not vals:
            skipped_blank += 1
            continue

        # Long layout: move the amount onto the utility-type-specific total
        # field so the template groups it correctly, expression included.
        # Keep the generic 'amount' too.
        utype = vals.get("utility_type", "")
        amount = vals.get("amount", "")
        if amount and utype:
            tf = _UTILITY_FIELD.get(_norm(utype))
            if tf:
                vals[tf] = amount
                if vals.get("amount_expr"):
                    vals[tf + "_expr"] = vals["amount_expr"]

        # A row with no money contributes nothing to the report. Counting it
        # separately means an unrecognised charges column surfaces as
        # "N rows had no amount" instead of silently exporting an empty
        # workbook.
        if not has_money:
            skipped_no_amount += 1
            continue

        # Use the service end date as the billing date the template buckets
        # on. Invoice-style dates already mapped to 'date' and are left
        # alone, so they aren't shifted by the pre-15th period adjustment.
        if vals.get("service_end_date"):
            vals.setdefault("billing_date", vals["service_end_date"])

        rows.append(vals)

    wb_val.close()
    wb_fml.close()
    return rows, headers, skipped_blank, skipped_no_amount, unmapped


@router.post("/api/utility-import")
async def utility_import(
    file: UploadFile = File(...),
    name: str = Form(...),
    created_by: str = Form("import"),
):
    """Parse an uploaded utility Excel and insert every row into a new batch."""
    filename = file.filename or "utilities.xlsx"
    if not filename.lower().endswith((".xlsx", ".xlsm", ".xls")):
        return JSONResponse(status_code=400, content={"error": "Please upload an .xlsx file."})

    data = await file.read()
    if not data:
        return JSONResponse(status_code=400, content={"error": "Uploaded file is empty."})

    try:
        rows, headers, skipped, skipped_no_amount, unmapped = _parse_rows(data)
    except Exception as exc:
        logger.exception("utility-import parse failed")
        return JSONResponse(status_code=400, content={"error": f"Could not read Excel: {exc}"})

    if not rows:
        detail = ", ".join(h for h in (headers or []) if h)
        hint = ""
        if skipped_no_amount:
            hint = (f" {skipped_no_amount} row(s) had no recognised amount — name the money"
                    " columns after the utility (Electricity, Gas, Water, Sewer, Trash,"
                    " Internet, Phone) or add a 'Current Charges' column.")
        return JSONResponse(status_code=400, content={
            "error": "No data rows found. Detected headers: " + detail + hint,
        })

    # One session_id for the whole import; page = 1-based row index (unique).
    session_id = "xls-" + uuid.uuid4().hex
    records = []
    for i, vals in enumerate(rows, start=1):
        # filename per row = property name so the utility template groups by
        # property; fall back to the workbook name.
        prop = vals.get("property_name") or filename
        records.append({
            "session_id": session_id,
            "filename": prop[:500],
            "page": i,
            "fields": vals,
        })

    try:
        batch_id = bs.create_batch(name, created_by, "utility_bill")
        inserted = bs.bulk_insert_records(batch_id, records)
    except Exception as exc:
        logger.exception("utility-import insert failed")
        return JSONResponse(status_code=500, content={"error": f"Database insert failed: {exc}"})

    return {
        "status": "ok",
        "batch_id": batch_id,
        "batch_name": name,
        "inserted": inserted,
        "skipped_blank": skipped,
        "skipped_no_amount": skipped_no_amount,
        "retained_formulas": sum(1 for r in rows for k in r if k.endswith("_expr")),
        "detected_headers": [h for h in (headers or []) if h],
        "unmapped_headers": unmapped,
        "mapped_fields": sorted({k for r in rows for k in r.keys()}),
    }
