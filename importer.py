"""Historical statement import orchestration (Step 13).

Two phases with the user's review in between:

prepare_import: bank -> file hash -> exact-PDF duplicate check -> frozen
parser (with its financial validation) -> transaction dedupe -> rule
categorisation -> internal-transfer marking -> review items. Purely
in-memory: nothing is written and the PDF is never copied.

finalize_import: checks the reviewed items still correspond to the prepared
ones (source identity fields unchanged), recomputes is_internal from the
final reviewed type, then inside ONE savepoint saves the eligible approved
transactions (Step 10), remembers requested rules (Step 12) and inserts the
completed `imports` row. Any error rolls every write back, so a failed
finalisation leaves no import, transaction or rule behind.
"""

import sqlite3
from contextlib import contextmanager
from pathlib import Path

from categorizer import categorize_transactions
from dedupe import find_duplicate_transactions, hash_file, is_file_duplicate
from internal_transfers import mark_internal_transfer, mark_internal_transfers
from pdf_intake import normalize_bank, process_pdf
from review import create_review_items
from rules import remember_review_choice
from transaction_store import save_review_items


class ImportDuplicateError(Exception):
    """This exact PDF (by content hash) has already been imported."""


class ImportValidationError(Exception):
    """The reviewed items do not correspond to the prepared import."""


IDENTITY_FIELDS = ("date", "description", "amount", "balance", "transaction_hash", "occurrence", "is_duplicate")
DECISIONS = (None, "approved", "rejected")
IMPORT_SQL = (
    "INSERT INTO imports (bank, original_filename, file_hash, statement_start_date, statement_end_date, "
    "status, parsed_count, approved_count) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)"
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
# Phase 1: prepare
# --------------------------------------------------------------------------

def prepare_import(db, pdf_path, bank):
    """Parse and analyse one statement PDF; returns the in-memory prepared import."""
    bank = normalize_bank(bank)
    path = Path(pdf_path)
    file_hash = hash_file(path)
    if is_file_duplicate(db, file_hash):
        raise ImportDuplicateError(f"{path.name} has already been imported (same file hash)")

    parsed = process_pdf(path, bank)
    transactions = parsed["transactions"]
    dedupe = find_duplicate_transactions(db, bank, transactions)
    marked = mark_internal_transfers(categorize_transactions(db, transactions))
    merged = [
        {
            **item, "bank": bank,
            "transaction_hash": record["transaction_hash"], "occurrence": record["occurrence"],
            "in_database": record["in_database"], "in_batch": record["in_batch"],
            "is_duplicate": record["is_duplicate"],
        }
        for item, record in zip(marked, dedupe)
    ]
    return {
        "bank": bank,
        "file_hash": file_hash,
        "original_filename": path.name,
        "statement_start_date": parsed["statement_start_date"],
        "statement_end_date": parsed["statement_end_date"],
        "parsed_count": len(transactions),
        "review_items": create_review_items(merged),
    }


# --------------------------------------------------------------------------
# Phase 2: finalise
# --------------------------------------------------------------------------

def _same(a, b):
    return type(a) is type(b) and a == b


def _final_items(prepared, reviewed_items):
    """Reviewed items checked against the prepared ones, with is_internal recomputed."""
    items = list(reviewed_items)
    originals = prepared["review_items"]
    if len(items) != len(originals):
        raise ImportValidationError(
            f"{len(items)} reviewed items for {len(originals)} prepared transactions"
        )
    final = []
    for index, (original, reviewed) in enumerate(zip(originals, items)):
        for field in IDENTITY_FIELDS:
            if not _same(reviewed.get(field), original.get(field)):
                raise ImportValidationError(f"item {index}: {field} differs from the prepared import")
        if "bank" in reviewed and not _same(reviewed["bank"], prepared["bank"]):
            raise ImportValidationError(f"item {index}: bank differs from the prepared import")
        if reviewed.get("decision") not in DECISIONS:
            raise ImportValidationError(f"item {index}: decision must be one of {DECISIONS}")
        if not isinstance(reviewed.get("remember_choice"), bool):
            raise ImportValidationError(f"item {index}: remember_choice must be True or False")
        final.append(mark_internal_transfer({**reviewed, "bank": prepared["bank"]}))
    return final


def finalize_import(db, prepared, reviewed_items):
    """Persist a reviewed import atomically; returns a compact count summary.

    With a path or a connection outside any transaction the writes are
    committed on return; inside a caller's open transaction they nest and
    the caller commits.
    """
    final = _final_items(prepared, reviewed_items)
    with _connection(db) as conn:
        if is_file_duplicate(conn, prepared["file_hash"]):
            raise ImportDuplicateError(f"{prepared['original_filename']} has already been imported")
        conn.execute("SAVEPOINT finalize_import")
        try:
            saved = save_review_items(conn, final)
            rule_counts = {"created": 0, "reactivated": 0, "already_exists": 0}
            for item in final:
                if item["decision"] == "approved" and item["remember_choice"]:
                    rule_counts[remember_review_choice(conn, item)["status"]] += 1
            try:
                cursor = conn.execute(IMPORT_SQL, (
                    prepared["bank"], prepared["original_filename"], prepared["file_hash"],
                    prepared["statement_start_date"], prepared["statement_end_date"],
                    prepared["parsed_count"], len(saved["saved"]),
                ))
            except sqlite3.IntegrityError as exc:
                if "UNIQUE" in str(exc):
                    raise ImportDuplicateError(
                        f"{prepared['original_filename']} was imported concurrently"
                    ) from None
                raise
        except BaseException:  # includes KeyboardInterrupt: never leave a half-finalised import behind
            conn.execute("ROLLBACK TO finalize_import")
            conn.execute("RELEASE finalize_import")
            raise
        conn.execute("RELEASE finalize_import")
    return {
        "status": "completed",
        "import_id": cursor.lastrowid,
        "parsed_count": prepared["parsed_count"],
        "saved_count": len(saved["saved"]),
        "rejected_count": len(saved["skipped_rejected"]),
        "undecided_count": len(saved["skipped_undecided"]),
        "internal_count": len(saved["skipped_internal"]),
        "duplicate_count": len(saved["skipped_duplicate"]),
        "conflict_count": len(saved["conflict"]),
        "rules_created": rule_counts["created"],
        "rules_reactivated": rule_counts["reactivated"],
        "rules_existing": rule_counts["already_exists"],
    }
