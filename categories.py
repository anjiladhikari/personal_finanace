"""Custom category management (Step 11).

Categories are user-defined rows of the SQLite `categories` table and are
never deleted, only deactivated, because stored transactions and rules refer
to them by name. Names are stored exactly as entered (surrounding whitespace
trimmed); lookups for add/activate/deactivate are case-insensitive so that
"Travel", "travel" and "TRAVEL" are one category.

Writes run inside a SAVEPOINT: standalone (or path) use commits, inside a
caller's open transaction they nest and the caller commits.
"""

import sqlite3
from contextlib import contextmanager
from pathlib import Path


class CategoryError(Exception):
    """A category operation is not allowed (bad name, duplicate, unknown category)."""


SELECT_SQL = "SELECT id, name, active, created_at FROM categories"
ORDER_SQL = " ORDER BY name COLLATE NOCASE, id"


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
    id_, name, active, created_at = row
    return {"id": id_, "name": name, "active": active == 1, "created_at": created_at}


def _clean_name(name):
    if not isinstance(name, str):
        raise CategoryError(f"category name must be a string, got {type(name).__name__}")
    cleaned = name.strip()
    if not cleaned:
        raise CategoryError("category name must not be empty")
    return cleaned


def _find(conn, name):
    """The stored category whose name matches case-insensitively, or None."""
    cursor = conn.cursor()
    cursor.row_factory = None
    wanted = name.casefold()
    for row in cursor.execute(SELECT_SQL + ORDER_SQL):
        if row[1].casefold() == wanted:
            return _record(row)
    return None


def _set_active(conn, category, active):
    if category["active"] == active:
        return category  # already in the requested state: idempotent
    with _savepoint(conn, "category_active"):
        conn.execute("UPDATE categories SET active = ? WHERE id = ?", (1 if active else 0, category["id"]))
    return {**category, "active": active}


def list_categories(db, *, include_inactive=False):
    """Categories as {id, name, active, created_at}, ordered by name (case-insensitive) then id."""
    sql = SELECT_SQL + ("" if include_inactive else " WHERE active = 1") + ORDER_SQL
    with _connection(db) as conn:
        cursor = conn.cursor()
        cursor.row_factory = None
        return [_record(row) for row in cursor.execute(sql)]


def add_category(db, name):
    """Create a category (active) or reactivate an inactive one with the same name.

    Raises CategoryError for an invalid name or if an active category with the
    same name (ignoring case) already exists.
    """
    cleaned = _clean_name(name)
    with _connection(db) as conn:
        existing = _find(conn, cleaned)
        if existing is not None:
            if existing["active"]:
                raise CategoryError(f"category {existing['name']!r} already exists")
            return _set_active(conn, existing, True)
        with _savepoint(conn, "category_add"):
            try:
                conn.execute("INSERT INTO categories (name, active) VALUES (?, 1)", (cleaned,))
            except sqlite3.IntegrityError:
                raise CategoryError(f"category {cleaned!r} already exists") from None
        return _find(conn, cleaned)


def deactivate_category(db, name):
    """Set active = 0 on the matching category; the row and its stored name are kept."""
    cleaned = _clean_name(name)
    with _connection(db) as conn:
        existing = _find(conn, cleaned)
        if existing is None:
            raise CategoryError(f"unknown category {cleaned!r}")
        return _set_active(conn, existing, False)


def activate_category(db, name):
    """Set active = 1 on the matching category. Never creates one."""
    cleaned = _clean_name(name)
    with _connection(db) as conn:
        existing = _find(conn, cleaned)
        if existing is None:
            raise CategoryError(f"unknown category {cleaned!r}")
        return _set_active(conn, existing, True)
