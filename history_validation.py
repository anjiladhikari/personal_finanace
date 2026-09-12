"""Read-only validation of imported history (Step 14).

Three questions, answered without touching any data:

- validate_import_integrity: are the completed `imports` rows internally sane?
- validate_storage_totals: does SUM(imports.approved_count) over completed
  imports equal COUNT(transactions)? (Every normal transaction saved by a
  successful finalisation increments approved_count.)
- validate_date_coverage: for an EXPLICIT list of import ids that the caller
  says form one account's history, which dates are covered, where are the
  gaps, where do statements overlap, and is an expected period complete?

The schema stores no account identifier and one bank can hold several
accounts, so statements are never grouped by bank automatically; the caller
must name the imports. No money is summed here: the parsers already
reconcile each statement's balances, and internal transfers, duplicates,
rejected and undecided rows are intentionally absent from `transactions`.
"""

import re
import sqlite3
from contextlib import contextmanager
from datetime import date, timedelta
from pathlib import Path

from pdf_intake import PDFIntakeError, normalize_bank


class HistoryValidationError(Exception):
    """Invalid input or database state for a history validation."""


ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SHA256_HEX = re.compile(r"^[0-9a-f]{64}$")
IMPORT_COLUMNS = ("id", "bank", "statement_start_date", "statement_end_date", "status",
                  "parsed_count", "approved_count", "file_hash")
IMPORTS_SQL = f"SELECT {', '.join(IMPORT_COLUMNS)} FROM imports"
ONE_DAY = timedelta(days=1)


@contextmanager
def _connection(db):
    """Yield an open connection from either a Connection or a path to an existing DB."""
    if isinstance(db, sqlite3.Connection):
        yield db
        return
    path = Path(db)
    if not path.is_file():
        raise FileNotFoundError(f"database not found: {path}")
    conn = sqlite3.connect(path)
    try:
        yield conn
    finally:
        conn.close()


def _rows(conn, sql, params=()):
    cursor = conn.cursor()
    cursor.row_factory = None
    return [dict(zip(IMPORT_COLUMNS, row)) for row in cursor.execute(sql, params)]


def _parse_date(value):
    """A strict YYYY-MM-DD string -> date, else None."""
    if not isinstance(value, str) or not ISO_DATE.fullmatch(value):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def _is_count(value):
    return type(value) is int and value >= 0


# --------------------------------------------------------------------------
# Part 1: import record integrity
# --------------------------------------------------------------------------

def _import_problems(row):
    problems = []
    start, end = _parse_date(row["statement_start_date"]), _parse_date(row["statement_end_date"])
    if start is None:
        problems.append("statement_start_date missing or not YYYY-MM-DD")
    if end is None:
        problems.append("statement_end_date missing or not YYYY-MM-DD")
    if start and end and start > end:
        problems.append("statement_start_date is after statement_end_date")
    if not _is_count(row["parsed_count"]):
        problems.append("parsed_count is not an integer >= 0")
    if not _is_count(row["approved_count"]):
        problems.append("approved_count is not an integer >= 0")
    if _is_count(row["parsed_count"]) and _is_count(row["approved_count"]) \
            and row["approved_count"] > row["parsed_count"]:
        problems.append("approved_count exceeds parsed_count")
    if not isinstance(row["file_hash"], str) or not SHA256_HEX.fullmatch(row["file_hash"]):
        problems.append("file_hash is not a lowercase SHA-256 hex string")
    try:
        normalize_bank(row["bank"])
    except PDFIntakeError:
        problems.append(f"unsupported bank {row['bank']!r}")
    return problems


def validate_import_integrity(db):
    """Check every completed import; returns {completed_import_count, problems, valid}."""
    with _connection(db) as conn:
        rows = _rows(conn, IMPORTS_SQL + " WHERE status = 'completed' ORDER BY id")
    problems = [
        {"import_id": row["id"], "problems": found}
        for row in rows if (found := _import_problems(row))
    ]
    return {"completed_import_count": len(rows), "problems": problems, "valid": not problems}


# --------------------------------------------------------------------------
# Part 2: global stored totals
# --------------------------------------------------------------------------

def validate_storage_totals(db):
    """SUM(approved_count) over completed imports must equal COUNT(transactions)."""
    with _connection(db) as conn:
        cursor = conn.cursor()
        cursor.row_factory = None
        completed, approved = cursor.execute(
            "SELECT COUNT(*), COALESCE(SUM(approved_count), 0) FROM imports WHERE status = 'completed'"
        ).fetchone()
        stored = cursor.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
    return {
        "completed_import_count": completed,
        "sum_approved_count": approved,
        "stored_transaction_count": stored,
        "matches": approved == stored,
    }


# --------------------------------------------------------------------------
# Part 3: date coverage of an explicitly selected history
# --------------------------------------------------------------------------

MAX_SQLITE_INT = 2 ** 63 - 1
ID_CHUNK = 500  # keep each IN (...) clause well under SQLite's variable limit


def _selected_imports(conn, import_ids):
    if isinstance(import_ids, (str, bytes)) or not hasattr(import_ids, "__iter__"):
        raise HistoryValidationError("import_ids must be a list of integers")
    ids = list(import_ids)
    if not ids:
        raise HistoryValidationError("import_ids must not be empty")
    if any(type(i) is not int or not 0 < i <= MAX_SQLITE_INT for i in ids):
        raise HistoryValidationError("import_ids must be positive integers")
    if len(set(ids)) != len(ids):
        raise HistoryValidationError("import_ids contains duplicates")
    rows = []
    for chunk in (ids[i:i + ID_CHUNK] for i in range(0, len(ids), ID_CHUNK)):
        placeholders = ", ".join("?" * len(chunk))
        rows += _rows(conn, IMPORTS_SQL + f" WHERE id IN ({placeholders})", chunk)
    missing = sorted(set(ids) - {row["id"] for row in rows})
    if missing:
        raise HistoryValidationError(f"unknown import ids: {missing}")
    periods = []
    for row in rows:
        if row["status"] != "completed":
            raise HistoryValidationError(f"import {row['id']} is {row['status']!r}, not completed")
        start, end = _parse_date(row["statement_start_date"]), _parse_date(row["statement_end_date"])
        if start is None or end is None or start > end:
            raise HistoryValidationError(f"import {row['id']} has an invalid statement period")
        if not (_is_count(row["parsed_count"]) and _is_count(row["approved_count"])
                and row["approved_count"] <= row["parsed_count"]):
            raise HistoryValidationError(f"import {row['id']} has invalid parsed_count/approved_count")
        try:
            bank = normalize_bank(row["bank"])
        except PDFIntakeError:
            raise HistoryValidationError(f"import {row['id']} has unsupported bank {row['bank']!r}") from None
        periods.append({**row, "bank": bank, "start": start, "end": end})
    banks = {row["bank"] for row in periods}
    if len(banks) != 1:
        raise HistoryValidationError(f"selected imports span several banks: {sorted(banks)}")
    return sorted(periods, key=lambda p: (p["start"], p["end"], p["id"]))


def _expected_range(expected_start, expected_end):
    if (expected_start is None) != (expected_end is None):
        raise HistoryValidationError("provide both expected_start and expected_end, or neither")
    if expected_start is None:
        return None
    start, end = _parse_date(expected_start), _parse_date(expected_end)
    if start is None or end is None:
        raise HistoryValidationError("expected_start and expected_end must be YYYY-MM-DD")
    if start > end:
        raise HistoryValidationError("expected_start must not be after expected_end")
    return start, end


def _merge(periods):
    """Merge overlapping or directly adjacent inclusive periods (already sorted)."""
    merged = []
    for period in periods:
        if merged and period["start"] <= merged[-1][1] + ONE_DAY:
            merged[-1][1] = max(merged[-1][1], period["end"])
        else:
            merged.append([period["start"], period["end"]])
    return merged


def _overlaps(periods):
    """Every pair of selected statements whose inclusive periods intersect."""
    found = []
    for i, a in enumerate(periods):
        for b in periods[i + 1:]:
            start, end = max(a["start"], b["start"]), min(a["end"], b["end"])
            if start <= end:
                found.append({"import_ids": sorted([a["id"], b["id"]]), "start": start.isoformat(),
                              "end": end.isoformat()})
    return found


def _gaps(merged, window_start, window_end):
    """Uncovered inclusive ranges inside [window_start, window_end]."""
    gaps = []
    cursor = window_start
    for start, end in merged:
        if end < cursor or start > window_end:
            continue
        if start > cursor:
            gaps.append({"start": cursor.isoformat(), "end": (start - ONE_DAY).isoformat()})
        cursor = max(cursor, end + ONE_DAY)
        if cursor > window_end:
            break
    if cursor <= window_end:
        gaps.append({"start": cursor.isoformat(), "end": window_end.isoformat()})
    return gaps


def _days(start_iso, end_iso):
    return (date.fromisoformat(end_iso) - date.fromisoformat(start_iso)).days + 1


def validate_date_coverage(db, import_ids, *, expected_start=None, expected_end=None):
    """Coverage, gaps and overlaps for the explicitly selected completed imports."""
    expected = _expected_range(expected_start, expected_end)
    with _connection(db) as conn:
        periods = _selected_imports(conn, import_ids)

    merged = _merge(periods)
    actual_start, actual_end = merged[0][0], merged[-1][1]
    window = expected or (actual_start, actual_end)
    gaps = _gaps(merged, *window)
    overlaps = _overlaps(periods)
    return {
        "bank": periods[0]["bank"],
        "import_count": len(periods),
        "statement_count": len(periods),
        "parsed_transaction_count": sum(p["parsed_count"] for p in periods),
        "saved_transaction_count": sum(p["approved_count"] for p in periods),
        "periods": [{"import_id": p["id"], "start": p["start"].isoformat(), "end": p["end"].isoformat()}
                    for p in periods],
        "actual_start": actual_start.isoformat(),
        "actual_end": actual_end.isoformat(),
        "covered_days": sum((end - start).days + 1 for start, end in merged),
        "gap_days": sum(_days(g["start"], g["end"]) for g in gaps),
        "gaps": gaps,
        "overlaps": overlaps,
        "has_gaps": bool(gaps),
        "has_overlaps": bool(overlaps),
        "expected_start": expected[0].isoformat() if expected else None,
        "expected_end": expected[1].isoformat() if expected else None,
        "expected_period_complete": (not gaps) if expected else None,
    }


def validate_history(db, import_ids=None, *, expected_start=None, expected_end=None):
    """Integrity + totals, plus coverage when import_ids are given."""
    coverage = None
    if import_ids is not None:
        coverage = validate_date_coverage(db, import_ids, expected_start=expected_start, expected_end=expected_end)
    return {
        "integrity": validate_import_integrity(db),
        "totals": validate_storage_totals(db),
        "coverage": coverage,
    }
