"""Review workflow state (Step 9).

A review item is a categorised transaction plus the user's review state:
remember_choice (their intention to keep this categorisation as a rule,
acted on in a later step) and decision (None, "approved" or "rejected").

The raw bank fields (date, description, amount, balance) are never edited.
The user may edit merchant, type, category and subcategory; a category must
exist and be active in SQLite. needs_review keeps describing what the
automatic categoriser did and is independent of the user's decision.

Every function returns a new dict and never mutates its input. Only category
validation touches the database, read-only.
"""

import sqlite3
from contextlib import contextmanager
from pathlib import Path


class ReviewValidationError(Exception):
    """A review edit or state is not allowed."""


RAW_FIELDS = ("date", "description", "amount", "balance")
EDITABLE_FIELDS = ("merchant", "type", "category", "subcategory")
DECISIONS = (None, "approved", "rejected")
CATEGORY_SQL = "SELECT active FROM categories WHERE name = ?"

_UNSET = object()


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


def _check_item(item):
    """Reject items that lack raw fields or carry review state set outside this API."""
    for field in RAW_FIELDS:
        if field not in item:
            raise ReviewValidationError(f"review item is missing raw field {field!r}")
    if not isinstance(item["remember_choice"], bool):
        raise ReviewValidationError("remember_choice must be True or False")
    if item["decision"] not in DECISIONS:
        raise ReviewValidationError(
            f"decision must be one of {DECISIONS}, got {item['decision']!r}"
        )


def _check_category(db, category):
    with _connection(db) as conn:
        cursor = conn.cursor()
        cursor.row_factory = None
        row = cursor.execute(CATEGORY_SQL, (category,)).fetchone()
    if row is None:
        raise ReviewValidationError(f"unknown category {category!r}")
    if row[0] != 1:
        raise ReviewValidationError(f"category {category!r} is inactive")


def create_review_item(transaction):
    """Copy of a categorised transaction with review defaults added where missing."""
    item = dict(transaction)
    for field in EDITABLE_FIELDS:
        item.setdefault(field, None)
    item.setdefault("remember_choice", False)
    item.setdefault("decision", None)
    _check_item(item)
    return item


def create_review_items(transactions):
    return [create_review_item(transaction) for transaction in transactions]


def update_review_item(db, review_item, *, merchant=_UNSET, type=_UNSET, category=_UNSET,
                       subcategory=_UNSET, remember_choice=_UNSET):
    """Copy of review_item with the given editable fields replaced.

    merchant/type/category/subcategory take a str or None; category must be
    an existing active category unless None. remember_choice takes a bool.
    Raw bank fields and decision cannot be changed here.
    """
    _check_item(review_item)
    item = dict(review_item)
    edits = {"merchant": merchant, "type": type, "category": category, "subcategory": subcategory}
    for field, value in edits.items():
        if value is _UNSET:
            continue
        if value is not None and not isinstance(value, str):
            raise ReviewValidationError(f"{field} must be a string or None")
        if field == "category" and value is not None:
            _check_category(db, value)
        item[field] = value
    if remember_choice is not _UNSET:
        if not isinstance(remember_choice, bool):
            raise ReviewValidationError("remember_choice must be True or False")
        item["remember_choice"] = remember_choice
    return item


def approve_review_item(review_item):
    """Copy of review_item with decision = "approved". Nothing is saved."""
    _check_item(review_item)
    return {**review_item, "decision": "approved"}


def reject_review_item(review_item):
    """Copy of review_item with decision = "rejected". Nothing is deleted."""
    _check_item(review_item)
    return {**review_item, "decision": "rejected"}
