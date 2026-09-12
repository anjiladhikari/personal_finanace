"""SQLite schema and initialisation for the personal finance app.

SQLite is the source of truth. Money is stored as integer cents.
Dates are stored as ISO 8601 text (YYYY-MM-DD).
"""

import os
import sqlite3
from pathlib import Path

# data/ is git-ignored, so the default database never reaches GitHub.
DEFAULT_DB_PATH = Path("data") / "finance.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS transactions (
    id               INTEGER PRIMARY KEY,
    bank             TEXT    NOT NULL,
    date             TEXT    NOT NULL,
    raw_description  TEXT    NOT NULL,           -- original bank text, never altered
    merchant         TEXT,
    amount           INTEGER NOT NULL,           -- cents; > 0 money in, < 0 money out
    balance          INTEGER,                    -- cents
    type             TEXT,
    category         TEXT,
    subcategory      TEXT,
    transaction_hash TEXT    NOT NULL UNIQUE,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions (date);

CREATE TABLE IF NOT EXISTS categories (
    id         INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL UNIQUE,
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rules (
    id          INTEGER PRIMARY KEY,
    pattern     TEXT    NOT NULL,                -- matched as an uppercase substring
    merchant    TEXT,
    type        TEXT,
    category    TEXT    NOT NULL,
    subcategory TEXT,
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS imports (
    id                   INTEGER PRIMARY KEY,
    bank                 TEXT    NOT NULL,
    original_filename    TEXT    NOT NULL,
    file_hash            TEXT    NOT NULL UNIQUE,
    statement_start_date TEXT,
    statement_end_date   TEXT,
    status               TEXT    NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'validated', 'completed', 'failed')),
    parsed_count         INTEGER NOT NULL DEFAULT 0,
    approved_count       INTEGER NOT NULL DEFAULT 0,
    created_at           TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS net_worth (
    id            INTEGER PRIMARY KEY,
    snapshot_date TEXT    NOT NULL,
    name          TEXT    NOT NULL,
    value         INTEGER NOT NULL,              -- cents
    notes         TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
"""


def init_db(db_path: str | os.PathLike = DEFAULT_DB_PATH) -> None:
    """Create all tables in the SQLite database at db_path.

    Safe to call repeatedly: every statement uses IF NOT EXISTS.
    """
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()


if __name__ == "__main__":
    init_db()
