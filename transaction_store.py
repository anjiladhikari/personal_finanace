"""Persist approved transactions into the SQLite `transactions` table (Step 10).

A reviewed item is saved only when the user approved it and it is neither an
internal transfer nor a duplicate. Rejected, undecided, internal and duplicate
rows are reported, never written and never mutated.

Eligible rows are validated first (types, bank, hash, active category), so a
bad row writes nothing. Inserts then run inside a SAVEPOINT: a UNIQUE
transaction_hash conflict is reported for that row and never overwrites the
existing row, while any other database error rolls the whole batch back.

This module writes to `transactions` only. It never touches `rules` or
`imports`, even when remember_choice is True.
"""

import re
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from pdf_intake import PDFIntakeError, normalize_bank


class SaveValidationError(Exception):
    """An eligible row cannot be saved as given."""


STATUSES = ("saved", "rejected", "undecided", "internal", "duplicate", "conflict")
SHA256_HEX = re.compile(r"^[0-9a-f]{64}$")
CATEGORY_SQL = "SELECT active FROM categories WHERE name = ?"
INSERT_SQL = (
    "INSERT INTO transactions (bank, date, raw_description, merchant, amount, balance, "
    "type, category, subcategory, transaction_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
)


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


# --------------------------------------------------------------------------
# Eligibility and validation
# --------------------------------------------------------------------------

def _flag(item, field):
    value = item.get(field)
    if not isinstance(value, bool):
        raise SaveValidationError(f"{field} must be True or False, got {value!r}")
    return value


def review_item_status(item):
    """'rejected' / 'undecided' / 'internal' / 'duplicate', or 'eligible' to save."""
    decision = item.get("decision")
    if decision == "rejected":
        return "rejected"
    if decision != "approved":
        return "undecided"
    if _flag(item, "is_internal"):
        return "internal"
    if _flag(item, "is_duplicate"):
        return "duplicate"
    return "eligible"


def _text(item, field, optional=False):
    value = item.get(field)
    if value is None and optional:
        return None
    if not isinstance(value, str):
        raise SaveValidationError(f"{field} must be a string{' or None' if optional else ''}, got {value!r}")
    return value


def _cents(item, field, optional=False):
    value = item.get(field)
    if value is None and optional:
        return None
    if type(value) is not int:  # bool and float are not money
        raise SaveValidationError(f"{field} must be integer cents{' or None' if optional else ''}, got {value!r}")
    return value


def _row(conn, item):
    """The validated INSERT parameters for one eligible item."""
    try:
        bank = normalize_bank(item.get("bank"))
    except PDFIntakeError as exc:
        raise SaveValidationError(str(exc)) from None
    transaction_hash = _text(item, "transaction_hash")
    if not SHA256_HEX.match(transaction_hash):
        raise SaveValidationError("transaction_hash must be a 64-character lowercase SHA-256 hex string")
    category = _text(item, "category", optional=True)
    if category is not None:
        cursor = conn.cursor()
        cursor.row_factory = None
        found = cursor.execute(CATEGORY_SQL, (category,)).fetchone()
        if found is None:
            raise SaveValidationError(f"unknown category {category!r}")
        if found[0] != 1:
            raise SaveValidationError(f"category {category!r} is inactive")
    return (
        bank,
        _text(item, "date"),
        _text(item, "description"),
        _text(item, "merchant", optional=True),
        _cents(item, "amount"),
        _cents(item, "balance", optional=True),
        _text(item, "type", optional=True),
        category,
        _text(item, "subcategory", optional=True),
        transaction_hash,
    )


# --------------------------------------------------------------------------
# Saving
# --------------------------------------------------------------------------

def save_review_items(db, review_items):
    """Save every eligible item in one all-or-nothing batch.

    Returns index lists: {"saved", "skipped_rejected", "skipped_undecided",
    "skipped_internal", "skipped_duplicate", "conflict"}. Raises
    SaveValidationError before writing anything if an eligible row is invalid.
    """
    items = list(review_items)
    result = {
        "saved": [], "skipped_rejected": [], "skipped_undecided": [],
        "skipped_internal": [], "skipped_duplicate": [], "conflict": [],
    }
    with _connection(db) as conn:
        rows = []
        for index, item in enumerate(items):
            status = review_item_status(item)
            if status == "eligible":
                rows.append((index, _row(conn, item)))
            else:
                result[f"skipped_{status}"].append(index)

        conn.execute("SAVEPOINT save_review_items")
        try:
            for index, row in rows:
                try:
                    conn.execute(INSERT_SQL, row)
                except sqlite3.IntegrityError as exc:
                    if "UNIQUE" not in str(exc):
                        raise
                    result["conflict"].append(index)  # existing row is left as it is
                else:
                    result["saved"].append(index)
        except Exception:
            conn.execute("ROLLBACK TO save_review_items")
            conn.execute("RELEASE save_review_items")
            raise
        conn.execute("RELEASE save_review_items")
    return result


def save_review_item(db, review_item):
    """Save one item; returns 'saved', 'rejected', 'undecided', 'internal', 'duplicate' or 'conflict'."""
    result = save_review_items(db, [review_item])
    for status in STATUSES:
        if result.get(status) or result.get(f"skipped_{status}"):
            return status
    raise AssertionError("save_review_items returned no outcome")  # pragma: no cover
