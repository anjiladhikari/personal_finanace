"""Duplicate detection for statement imports (Step 6).

Two independent protections, both SHA-256 and fully deterministic:

- file_hash: hash of a PDF's exact bytes. The same statement PDF imported
  twice (even renamed) is recognised via imports.file_hash.
- transaction_hash: hash of a canonical JSON record of the source identity
  fields {bank, date, raw_description, amount, balance, occurrence}. The same
  source transaction appearing in overlapping statements is recognised via
  transactions.transaction_hash.

  occurrence is the 1-based ordinal of that exact five-field tuple within
  the parsed statement, in parser order. Real statements contain distinct
  transactions whose five source fields are identical (e.g. a transfer in,
  out and in again on one day, so the balance repeats); occurrence keeps
  them apart while staying reproducible when an overlapping statement is
  imported, because it counts only among identical tuples, never by
  position in the statement. It lives only inside the hash.

This module only computes identities and reads SQLite. It never inserts,
updates or deletes rows, and never alters the parser's transaction objects.
"""

import hashlib
import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from pdf_intake import normalize_bank

CHUNK_SIZE = 1024 * 1024  # bytes read per iteration when hashing a file

FILE_HASH_SQL = "SELECT 1 FROM imports WHERE file_hash = ? LIMIT 1"
TRANSACTION_HASH_SQL = "SELECT 1 FROM transactions WHERE transaction_hash = ? LIMIT 1"


# --------------------------------------------------------------------------
# Hashes
# --------------------------------------------------------------------------

def hash_file(path):
    """Lowercase SHA-256 hex of the file's bytes, read in chunks."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(CHUNK_SIZE), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _text(value, field):
    if type(value) is not str:
        raise TypeError(f"{field} must be a string, got {type(value).__name__}")
    return value


def _integer_cents(value, field, allow_none=False):
    if value is None and allow_none:
        return None
    if type(value) is not int:  # bool and float are not money
        raise TypeError(f"{field} must be integer cents, got {type(value).__name__}")
    return value


def _source_fields(bank, transaction):
    """The five validated source identity fields, as a hashable tuple."""
    return (
        normalize_bank(bank),
        _text(transaction["date"], "date"),
        _text(transaction["description"], "description"),
        _integer_cents(transaction["amount"], "amount"),
        _integer_cents(transaction["balance"], "balance", allow_none=True),
    )


def transaction_hash(bank, transaction, occurrence=1):
    """Lowercase SHA-256 hex identifying one source transaction.

    Built from exactly bank, date, raw_description (the parser's untouched
    "description"), amount, balance and occurrence, serialised as canonical
    JSON: sorted keys, compact separators, UTF-8. Nothing is trimmed or
    re-cased. occurrence defaults to 1 (a tuple seen once in its statement);
    find_duplicate_transactions assigns it for a whole statement.
    """
    if type(occurrence) is not int:
        raise TypeError(f"occurrence must be an int, got {type(occurrence).__name__}")
    if occurrence < 1:
        raise ValueError(f"occurrence must be >= 1, got {occurrence}")
    bank_name, date, raw_description, amount, balance = _source_fields(bank, transaction)
    record = {
        "bank": bank_name,
        "date": date,
        "raw_description": raw_description,
        "amount": amount,
        "balance": balance,
        "occurrence": occurrence,
    }
    canonical = json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------
# SQLite lookups (read-only)
# --------------------------------------------------------------------------

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


def _exists(conn, sql, value):
    return conn.execute(sql, (value,)).fetchone() is not None


def is_file_duplicate(db, file_hash):
    """True if imports already holds this file_hash."""
    with _connection(db) as conn:
        return _exists(conn, FILE_HASH_SQL, file_hash)


def is_transaction_duplicate(db, transaction_hash):
    """True if transactions already holds this transaction_hash."""
    with _connection(db) as conn:
        return _exists(conn, TRANSACTION_HASH_SQL, transaction_hash)


# --------------------------------------------------------------------------
# Convenience checks for later orchestration
# --------------------------------------------------------------------------

def check_file(db, path):
    """PDF bytes -> {"file_hash", "is_duplicate"}; nothing is inserted."""
    file_hash = hash_file(path)
    return {"file_hash": file_hash, "is_duplicate": is_file_duplicate(db, file_hash)}


def find_duplicate_transactions(db, bank, transactions):
    """Assign occurrences, hash each parsed transaction and flag duplicates.

    Walks the statement in parser order, counting how often each exact
    five-field tuple has appeared so far; that count is the transaction's
    occurrence (1 for the first, 2 for the next identical tuple, ...).
    Returns one record per input transaction, in order:
    {"transaction": <the original object, unmodified>, "occurrence": ...,
     "transaction_hash": ..., "in_database": ..., "in_batch": ..., "is_duplicate": ...}
    A duplicate is a six-field identity that already exists. Identical
    tuples within one statement get different occurrences and are therefore
    separate transactions; in_batch cannot become True once occurrences are
    assigned and is kept only as a guard.
    """
    occurrences = {}
    seen = set()
    results = []
    with _connection(db) as conn:
        for transaction in transactions:
            fields = _source_fields(bank, transaction)
            occurrence = occurrences.get(fields, 0) + 1
            occurrences[fields] = occurrence
            digest = transaction_hash(bank, transaction, occurrence)
            in_database = _exists(conn, TRANSACTION_HASH_SQL, digest)
            in_batch = digest in seen
            seen.add(digest)
            results.append({
                "transaction": transaction,
                "occurrence": occurrence,
                "transaction_hash": digest,
                "in_database": in_database,
                "in_batch": in_batch,
                "is_duplicate": in_database or in_batch,
            })
    return results
