"""Remembered categorisation rules (Step 12).

When the user approves a reviewed transaction with remember_choice=True, its
raw description becomes the pattern of a rule in the SQLite `rules` table,
carrying exactly the merchant/type/category/subcategory the user reviewed.
Step 7 keeps matching rules as plain case-insensitive substrings; nothing
here changes that, and nothing here saves transactions.

Duplicate patterns (compared case-insensitively) are never inserted twice:
an identical rule is reported or reactivated, a differing one is a conflict
the user must resolve. rules.category is NOT NULL in the schema, so a rule
cannot be remembered without a category.

Writes run inside a SAVEPOINT: standalone (or path) use commits, inside a
caller's open transaction they nest and the caller commits.
"""

import sqlite3
from contextlib import contextmanager
from pathlib import Path


class RuleValidationError(Exception):
    """The review item cannot be remembered as a rule as given."""


class RuleConflictError(Exception):
    """A rule with the same pattern already exists with different remembered fields."""


RULE_FIELDS = ("merchant", "type", "category", "subcategory")
SELECT_SQL = "SELECT id, pattern, merchant, type, category, subcategory, active, created_at FROM rules"
ORDER_SQL = " ORDER BY pattern COLLATE NOCASE, id"
CATEGORY_SQL = "SELECT active FROM categories WHERE name = ?"
INSERT_SQL = (
    "INSERT INTO rules (pattern, merchant, type, category, subcategory, active) VALUES (?, ?, ?, ?, ?, 1)"
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


@contextmanager
def _savepoint(conn, name):
    conn.execute(f"SAVEPOINT {name}")
    try:
        yield
    except Exception:
        conn.execute(f"ROLLBACK TO {name}")
        conn.execute(f"RELEASE {name}")
        raise
    conn.execute(f"RELEASE {name}")


def _record(row):
    id_, pattern, merchant, type_, category, subcategory, active, created_at = row
    return {
        "id": id_, "pattern": pattern, "merchant": merchant, "type": type_, "category": category,
        "subcategory": subcategory, "active": active == 1, "created_at": created_at,
    }


def _find(conn, pattern):
    """All stored rules whose pattern matches case-insensitively, in listing order.

    Uses .upper() so "the same pattern" means exactly what Step 7's
    pattern.upper() substring matching treats as the same.
    """
    cursor = conn.cursor()
    cursor.row_factory = None
    wanted = pattern.upper()
    return [_record(row) for row in cursor.execute(SELECT_SQL + ORDER_SQL) if row[1].upper() == wanted]


def _find_one(conn, pattern):
    matches = _find(conn, pattern)
    if not matches:
        raise RuleValidationError(f"unknown rule pattern {pattern!r}")
    if len(matches) > 1:
        raise RuleConflictError(f"{len(matches)} rules share the pattern {pattern!r}; resolve them first")
    return matches[0]


def _set_active(conn, rule, active):
    if rule["active"] == active:
        return rule  # already in the requested state: idempotent
    with _savepoint(conn, "rule_active"):
        conn.execute("UPDATE rules SET active = ? WHERE id = ?", (1 if active else 0, rule["id"]))
    return {**rule, "active": active}


def _optional_text(item, field):
    value = item.get(field)
    if value is not None and not isinstance(value, str):
        raise RuleValidationError(f"{field} must be a string or None, got {value!r}")
    return value


def _check_category(conn, category):
    cursor = conn.cursor()
    cursor.row_factory = None
    row = cursor.execute(CATEGORY_SQL, (category,)).fetchone()
    if row is None:
        raise RuleValidationError(f"unknown category {category!r}")
    if row[0] != 1:
        raise RuleValidationError(f"category {category!r} is inactive")


# --------------------------------------------------------------------------
# Remember choice
# --------------------------------------------------------------------------

def remember_review_choice(db, review_item):
    """Create (or reactivate) the rule an approved review item asked to remember.

    Returns {"status": "created" | "already_exists" | "reactivated" | "not_requested",
             "rule": <rule record or None>}.
    Raises RuleValidationError for invalid input and RuleConflictError when the
    same pattern is already remembered with different fields.
    """
    remember = review_item.get("remember_choice")
    if not isinstance(remember, bool):
        raise RuleValidationError("remember_choice must be True or False")
    if not remember:
        return {"status": "not_requested", "rule": None}
    if review_item.get("decision") != "approved":
        raise RuleValidationError("only an approved review item can be remembered")

    pattern = review_item.get("description")
    if not isinstance(pattern, str) or not pattern.strip():
        raise RuleValidationError("description must be a non-empty string to become a rule pattern")
    fields = {field: _optional_text(review_item, field) for field in RULE_FIELDS}
    if fields["category"] is None:
        raise RuleValidationError("a category is required to remember a rule")

    with _connection(db) as conn:
        _check_category(conn, fields["category"])
        existing = _find(conn, pattern)
        if not existing:
            with _savepoint(conn, "rule_create"):
                conn.execute(INSERT_SQL, (pattern, fields["merchant"], fields["type"],
                                          fields["category"], fields["subcategory"]))
            [rule] = _find(conn, pattern)
            return {"status": "created", "rule": rule}
        if len(existing) > 1:
            raise RuleConflictError(f"{len(existing)} rules share the pattern {pattern!r}; resolve them first")
        rule = existing[0]
        differing = [field for field in RULE_FIELDS if rule[field] != fields[field]]
        if differing:
            raise RuleConflictError(
                f"a rule for this pattern already exists with different {', '.join(differing)}"
            )
        if rule["active"]:
            return {"status": "already_exists", "rule": rule}
        return {"status": "reactivated", "rule": _set_active(conn, rule, True)}


# --------------------------------------------------------------------------
# Minimal management
# --------------------------------------------------------------------------

def list_rules(db, *, include_inactive=False):
    sql = SELECT_SQL + ("" if include_inactive else " WHERE active = 1") + ORDER_SQL
    with _connection(db) as conn:
        cursor = conn.cursor()
        cursor.row_factory = None
        return [_record(row) for row in cursor.execute(sql)]


def deactivate_rule(db, pattern):
    """Set active = 0 on the rule with this pattern (case-insensitive); the row is kept."""
    with _connection(db) as conn:
        return _set_active(conn, _find_one(conn, _pattern(pattern)), False)


def activate_rule(db, pattern):
    """Set active = 1 on the rule with this pattern (case-insensitive). Never creates one."""
    with _connection(db) as conn:
        return _set_active(conn, _find_one(conn, _pattern(pattern)), True)


def _pattern(pattern):
    if not isinstance(pattern, str) or not pattern.strip():
        raise RuleValidationError("pattern must be a non-empty string")
    return pattern
