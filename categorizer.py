"""Deterministic rule-based categorisation (Step 7).

A parsed transaction is categorised only by rows of the SQLite `rules`
table: a rule matches when rule.pattern.upper() is a substring of the raw
description upper-cased. Nothing is inferred from the amount sign, no
merchant is extracted from the description, and no category name is
hard-coded here.

Outcome per transaction (a copy of the input with five fields added):
- exactly one active rule matches and its category exists and is active
  -> merchant/type/category/subcategory from that rule, needs_review False
- no active rule matches, more than one matches, or any matching rule
  points to a missing/inactive category -> all four None, needs_review True

This module only reads the database.
"""

import sqlite3
from contextlib import contextmanager
from pathlib import Path

RULES_SQL = (
    "SELECT r.pattern, r.merchant, r.type, r.category, r.subcategory, c.active "
    "FROM rules AS r LEFT JOIN categories AS c ON c.name = r.category "
    "WHERE r.active = 1 ORDER BY r.id"
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


def _active_rules(conn):
    """Active rules as dicts; category_active is 1, 0 (inactive) or None (missing)."""
    cursor = conn.cursor()
    cursor.row_factory = None  # plain tuples whatever the caller's connection row_factory is
    return [
        {
            "pattern": pattern,
            "merchant": merchant,
            "type": type_,
            "category": category,
            "subcategory": subcategory,
            "category_active": category_active,
        }
        for pattern, merchant, type_, category, subcategory, category_active
        in cursor.execute(RULES_SQL)
    ]


def _apply_rules(rules, transaction):
    description = transaction["description"]
    haystack = description.upper()  # comparison only; the description itself is untouched
    matches = [rule for rule in rules if rule["pattern"].upper() in haystack]

    result = dict(transaction)
    if len(matches) == 1 and matches[0]["category_active"] == 1:
        rule = matches[0]
        result.update(
            merchant=rule["merchant"],
            type=rule["type"],
            category=rule["category"],
            subcategory=rule["subcategory"],
            needs_review=False,
        )
    else:
        result.update(merchant=None, type=None, category=None, subcategory=None, needs_review=True)
    return result


def categorize_transactions(db, transactions):
    """Categorise each parsed transaction, in input order, using the active rules."""
    with _connection(db) as conn:
        rules = _active_rules(conn)
    return [_apply_rules(rules, transaction) for transaction in transactions]


def categorize_transaction(db, transaction):
    """Categorise one parsed transaction; returns a copy with the five fields added."""
    return categorize_transactions(db, [transaction])[0]
