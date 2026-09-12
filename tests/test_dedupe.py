"""Step 6 tests for dedupe: file hashes, transaction hashes, duplicate checks.

Synthetic data only: made-up bytes, made-up transactions, a throwaway
SQLite database created with init_db() in a temporary directory.
"""

import copy
import hashlib
import re
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from database import init_db
from dedupe import (
    CHUNK_SIZE,
    check_file,
    find_duplicate_transactions,
    hash_file,
    is_file_duplicate,
    is_transaction_duplicate,
    transaction_hash,
)

SHA256_HEX = re.compile(r"^[0-9a-f]{64}$")


def txn(**overrides):
    """A made-up parser-shaped transaction."""
    base = {"date": "2026-01-05", "description": "TEST SHOP 1 SUBURB", "amount": -1200, "balance": 378}
    base.update(overrides)
    return base


class DedupeTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)
        self.db_path = self.dir / "test.db"
        init_db(self.db_path)
        self.conn = sqlite3.connect(self.db_path)
        self.addCleanup(self.conn.close)

    def insert_import(self, file_hash):
        self.conn.execute(
            "INSERT INTO imports (bank, original_filename, file_hash) VALUES (?, ?, ?)",
            ("commbank", "made-up.pdf", file_hash),
        )
        self.conn.commit()

    def insert_transaction(self, bank, transaction):
        self.conn.execute(
            "INSERT INTO transactions (bank, date, raw_description, amount, balance, transaction_hash)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (bank, transaction["date"], transaction["description"], transaction["amount"],
             transaction["balance"], transaction_hash(bank, transaction)),
        )
        self.conn.commit()


class FileHashTests(DedupeTestCase):
    def test_identical_bytes_identical_hash(self):
        a = self.dir / "a.pdf"
        b = self.dir / "b.pdf"
        a.write_bytes(b"%PDF-1.4 made up bytes")
        b.write_bytes(b"%PDF-1.4 made up bytes")
        self.assertEqual(hash_file(a), hash_file(b))

    def test_renamed_file_same_hash(self):
        original = self.dir / "statement.pdf"
        original.write_bytes(b"%PDF-1.4 made up bytes")
        before = hash_file(original)
        renamed = original.rename(self.dir / "completely different name.pdf")
        self.assertEqual(hash_file(renamed), before)

    def test_different_bytes_different_hash(self):
        a = self.dir / "a.pdf"
        b = self.dir / "b.pdf"
        a.write_bytes(b"%PDF-1.4 made up bytes")
        b.write_bytes(b"%PDF-1.4 made up bytes.")
        self.assertNotEqual(hash_file(a), hash_file(b))

    def test_reads_in_chunks(self):
        big = self.dir / "big.pdf"
        big.write_bytes(b"y" * (2 * CHUNK_SIZE + 1))
        read_sizes = []
        real_open = open

        def recording_open(path, mode):
            handle = real_open(path, mode)
            original_read = handle.read
            handle.read = lambda n=-1: (read_sizes.append(n), original_read(n))[1]
            return handle

        with patch("dedupe.open", recording_open, create=True):
            digest = hash_file(big)
        self.assertEqual(digest, hashlib.sha256(b"y" * (2 * CHUNK_SIZE + 1)).hexdigest())
        self.assertGreaterEqual(len(read_sizes), 3)
        self.assertTrue(all(0 < n <= CHUNK_SIZE for n in read_sizes), read_sizes)

    def test_is_plain_sha256_of_contents(self):
        big = self.dir / "big.pdf"
        data = b"x" * (3 * 1024 * 1024 + 17)  # spans several read chunks
        big.write_bytes(data)
        digest = hash_file(big)
        self.assertRegex(digest, SHA256_HEX)
        self.assertEqual(digest, hashlib.sha256(data).hexdigest())


class TransactionHashTests(unittest.TestCase):
    def test_identical_fields_identical_hash(self):
        self.assertEqual(transaction_hash("commbank", txn()), transaction_hash("commbank", txn()))

    def test_deterministic_across_calls_and_bank_spelling(self):
        first = transaction_hash("CommBank", txn())
        for _ in range(5):
            self.assertEqual(transaction_hash("commbank", txn()), first)
        self.assertEqual(transaction_hash(" COMMBANK ", txn()), first)

    def test_each_source_field_changes_hash(self):
        base = transaction_hash("commbank", txn())
        self.assertNotEqual(transaction_hash("ing", txn()), base)
        self.assertNotEqual(transaction_hash("commbank", txn(date="2026-01-06")), base)
        self.assertNotEqual(transaction_hash("commbank", txn(description="TEST SHOP 2 SUBURB")), base)
        self.assertNotEqual(transaction_hash("commbank", txn(amount=-1201)), base)
        self.assertNotEqual(transaction_hash("commbank", txn(balance=379)), base)

    def test_description_is_used_verbatim(self):
        base = transaction_hash("commbank", txn())
        self.assertNotEqual(transaction_hash("commbank", txn(description=" TEST SHOP 1 SUBURB")), base)
        self.assertNotEqual(transaction_hash("commbank", txn(description="test shop 1 suburb")), base)
        self.assertNotEqual(transaction_hash("commbank", txn(description="TEST SHOP 1  SUBURB")), base)

    def test_none_balance_hashes_distinctly(self):
        digest = transaction_hash("commbank", txn(balance=None))
        self.assertRegex(digest, SHA256_HEX)
        self.assertNotEqual(digest, transaction_hash("commbank", txn(balance=0)))

    def test_format_and_canonical_serialisation(self):
        digest = transaction_hash("ing", txn(description="Café ☕ purchase"))
        self.assertRegex(digest, SHA256_HEX)
        canonical = (
            '{"amount":-1200,"balance":378,"bank":"ing","date":"2026-01-05",'
            '"occurrence":1,"raw_description":"Café ☕ purchase"}'
        )
        self.assertEqual(digest, hashlib.sha256(canonical.encode("utf-8")).hexdigest())
        self.assertEqual(digest, transaction_hash("ing", txn(description="Café ☕ purchase"), occurrence=1))

    def test_occurrence_changes_hash_and_is_validated(self):
        hashes = {transaction_hash("commbank", txn(), occurrence=n) for n in (1, 2, 3)}
        self.assertEqual(len(hashes), 3)
        for bad in (0, -1, 1.0, True, "1", None):
            with self.subTest(occurrence=bad), self.assertRaises((TypeError, ValueError)):
                transaction_hash("commbank", txn(), occurrence=bad)

    def test_non_integer_money_is_rejected(self):
        for bad in (txn(amount=-12.0), txn(balance=3.78), txn(amount=True), txn(amount="-1200")):
            with self.subTest(bad=bad), self.assertRaises(TypeError):
                transaction_hash("commbank", bad)

    def test_non_string_date_or_description_is_rejected(self):
        for bad in (txn(date=20260105), txn(date=None), txn(description=None), txn(description=b"x")):
            with self.subTest(bad=bad), self.assertRaises(TypeError):
                transaction_hash("commbank", bad)

    def test_unsupported_bank_is_rejected(self):
        from pdf_intake import PDFIntakeError
        with self.assertRaises(PDFIntakeError):
            transaction_hash("westpac", txn())

    def test_input_is_not_mutated(self):
        original = txn()
        snapshot = copy.deepcopy(original)
        transaction_hash("commbank", original)
        self.assertEqual(original, snapshot)
        self.assertIs(type(original["amount"]), int)
        self.assertIs(type(original["balance"]), int)


class DatabaseCheckTests(DedupeTestCase):
    def test_known_file_hash_detected(self):
        self.insert_import("a" * 64)
        self.assertTrue(is_file_duplicate(self.conn, "a" * 64))
        self.assertTrue(is_file_duplicate(self.db_path, "a" * 64))

    def test_unknown_file_hash_not_detected(self):
        self.insert_import("a" * 64)
        self.assertFalse(is_file_duplicate(self.conn, "b" * 64))
        self.assertFalse(is_file_duplicate(self.db_path, "b" * 64))

    def test_known_transaction_hash_detected(self):
        self.insert_transaction("commbank", txn())
        digest = transaction_hash("commbank", txn())
        self.assertTrue(is_transaction_duplicate(self.conn, digest))
        self.assertTrue(is_transaction_duplicate(self.db_path, digest))

    def test_unknown_transaction_hash_not_detected(self):
        self.insert_transaction("commbank", txn())
        digest = transaction_hash("commbank", txn(amount=-1201))
        self.assertFalse(is_transaction_duplicate(self.conn, digest))
        self.assertFalse(is_transaction_duplicate(self.db_path, digest))

    def test_check_file_reports_status_without_inserting(self):
        pdf = self.dir / "made-up.pdf"
        pdf.write_bytes(b"%PDF-1.4 made up bytes")
        status = check_file(self.conn, pdf)
        self.assertEqual(status, {"file_hash": hash_file(pdf), "is_duplicate": False})
        self.assertEqual(check_file(self.db_path, pdf), status)
        self.insert_import(status["file_hash"])
        self.assertEqual(check_file(self.conn, pdf), {"file_hash": status["file_hash"], "is_duplicate": True})
        self.assertEqual(check_file(self.db_path, pdf)["is_duplicate"], True)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM imports").fetchone()[0], 1)

    def test_lookups_are_parameterised(self):
        """Quote characters in a value must be data, never SQL."""
        self.insert_import("a" * 64)
        self.insert_transaction("commbank", txn())
        for odd in ("' OR 1=1 --", "it's", "a' OR '1'='1"):
            with self.subTest(value=odd):
                self.assertFalse(is_file_duplicate(self.conn, odd))
                self.assertFalse(is_transaction_duplicate(self.conn, odd))
        self.insert_import("it's")
        self.assertTrue(is_file_duplicate(self.conn, "it's"))

    def test_missing_database_path_is_rejected(self):
        with self.assertRaises(FileNotFoundError):
            is_file_duplicate(self.dir / "nope.db", "a" * 64)
        self.assertFalse((self.dir / "nope.db").exists())  # nothing created


class BatchDedupeTests(DedupeTestCase):
    def test_existing_db_transaction_marked_duplicate(self):
        self.insert_transaction("ing", txn())
        [record] = find_duplicate_transactions(self.conn, "ing", [txn()])
        self.assertTrue(record["in_database"])
        self.assertFalse(record["in_batch"])
        self.assertTrue(record["is_duplicate"])
        self.assertEqual(record["transaction_hash"], transaction_hash("ing", txn()))

    def test_unseen_transaction_not_duplicate(self):
        self.insert_transaction("ing", txn())
        [record] = find_duplicate_transactions(self.conn, "ing", [txn(balance=379)])
        self.assertFalse(record["is_duplicate"])
        self.assertFalse(record["in_database"])
        self.assertFalse(record["in_batch"])

    def test_identical_tuples_get_increasing_occurrences_and_distinct_hashes(self):
        # X, -X, X, X on one day: three legitimate transactions share every source field
        batch = [txn(), txn(amount=1200, balance=1578), txn(), txn()]
        records = find_duplicate_transactions(self.db_path, "commbank", batch)
        self.assertEqual([r["occurrence"] for r in records], [1, 1, 2, 3])
        self.assertEqual(len({r["transaction_hash"] for r in records}), 4)
        self.assertEqual([r["in_batch"] for r in records], [False] * 4)
        self.assertEqual([r["in_database"] for r in records], [False] * 4)
        self.assertEqual([r["is_duplicate"] for r in records], [False] * 4)
        for record in records:
            self.assertEqual(
                record["transaction_hash"],
                transaction_hash("commbank", record["transaction"], record["occurrence"]),
            )

    def test_ordinary_unique_transactions_get_occurrence_one(self):
        batch = [txn(), txn(amount=-500, balance=-122), txn(date="2026-01-06", balance=378)]
        records = find_duplicate_transactions(self.conn, "commbank", batch)
        self.assertEqual([r["occurrence"] for r in records], [1, 1, 1])
        self.assertEqual([r["transaction_hash"] for r in records], [transaction_hash("commbank", t) for t in batch])

    def test_repeating_the_same_statement_reproduces_hashes(self):
        batch = [txn(), txn(amount=1200, balance=1578), txn(), txn(balance=379), txn()]
        first = find_duplicate_transactions(self.conn, "ing", copy.deepcopy(batch))
        second = find_duplicate_transactions(self.conn, "ing", copy.deepcopy(batch))
        self.assertEqual([r["transaction_hash"] for r in first], [r["transaction_hash"] for r in second])
        self.assertEqual([r["occurrence"] for r in first], [r["occurrence"] for r in second])

    def test_overlapping_statement_reproduces_occurrences(self):
        """Occurrence counts among identical tuples only, so statement boundaries don't matter."""
        x, y = txn(), txn(amount=1200, balance=1578)
        earlier = [txn(date="2026-01-04", balance=-822), x, y, x]           # statement ending mid-week
        later = [x, y, x, txn(date="2026-01-06", amount=-100, balance=278)]  # statement starting that day
        first = find_duplicate_transactions(self.conn, "ing", earlier)
        second = find_duplicate_transactions(self.conn, "ing", later)
        self.assertEqual([r["occurrence"] for r in first[1:]], [1, 1, 2])
        self.assertEqual([r["occurrence"] for r in second[:3]], [1, 1, 2])
        self.assertEqual([r["transaction_hash"] for r in first[1:]], [r["transaction_hash"] for r in second[:3]])

    def test_existing_occurrence_one_detected_independently_of_two(self):
        self.insert_transaction("commbank", txn())  # stores the occurrence-1 hash
        first, second = find_duplicate_transactions(self.conn, "commbank", [txn(), txn()])
        self.assertEqual((first["occurrence"], first["in_database"], first["is_duplicate"]), (1, True, True))
        self.assertEqual((second["occurrence"], second["in_database"], second["is_duplicate"]), (2, False, False))
        self.assertFalse(second["in_batch"])

        # now store the occurrence-2 hash as well: both are known, neither is an in-batch duplicate
        self.conn.execute(
            "INSERT INTO transactions (bank, date, raw_description, amount, balance, transaction_hash)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            ("commbank", "2026-01-05", "TEST SHOP 1 SUBURB", -1200, 378, second["transaction_hash"]),
        )
        self.conn.commit()
        records = find_duplicate_transactions(self.conn, "commbank", [txn(), txn()])
        self.assertEqual([r["in_database"] for r in records], [True, True])
        self.assertEqual([r["in_batch"] for r in records], [False, False])
        self.assertTrue(is_transaction_duplicate(self.conn, transaction_hash("commbank", txn(), 2)))
        self.assertFalse(is_transaction_duplicate(self.conn, transaction_hash("commbank", txn(), 3)))

    def test_same_bank_is_part_of_identity(self):
        self.insert_transaction("commbank", txn())
        [record] = find_duplicate_transactions(self.conn, "ing", [txn()])
        self.assertFalse(record["is_duplicate"])

    def test_original_transactions_not_mutated(self):
        batch = [txn(), txn(amount=5000, balance=5378), txn(), txn()]
        snapshot = copy.deepcopy(batch)
        records = find_duplicate_transactions(self.conn, "commbank", batch)
        self.assertEqual(batch, snapshot)
        self.assertEqual([r["occurrence"] for r in records], [1, 1, 2, 3])
        for record, original in zip(records, batch):
            self.assertIs(record["transaction"], original)
            self.assertNotIn("occurrence", original)
            self.assertIs(type(original["amount"]), int)
            self.assertIs(type(original["balance"]), int)
            self.assertRegex(record["transaction_hash"], SHA256_HEX)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
