"""Step 1 tests: schema creation and uniqueness constraints.

Runs with either `python3 -m unittest` or `python3 -m pytest`.
Uses a throwaway SQLite file in a temporary directory — no real data.
"""

import sqlite3
import tempfile
import unittest
from pathlib import Path

from database import init_db

EXPECTED_TABLES = {"transactions", "categories", "rules", "imports", "net_worth"}


class InitDbTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self._tmp.name) / "test.db"
        init_db(self.db_path)
        self.conn = sqlite3.connect(self.db_path)

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def table_names(self):
        rows = self.conn.execute(
            "SELECT name FROM sqlite_master "
            "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
        return {row[0] for row in rows}

    def test_creates_exactly_five_tables(self):
        self.assertEqual(self.table_names(), EXPECTED_TABLES)

    def test_init_db_can_run_twice(self):
        init_db(self.db_path)  # must not raise
        self.assertEqual(self.table_names(), EXPECTED_TABLES)

    def test_duplicate_import_file_hash_rejected(self):
        sql = "INSERT INTO imports (bank, original_filename, file_hash) VALUES (?, ?, ?)"
        self.conn.execute(sql, ("CommBank", "first.pdf", "samehash"))
        with self.assertRaises(sqlite3.IntegrityError):
            self.conn.execute(sql, ("CommBank", "second.pdf", "samehash"))

    def test_duplicate_transaction_hash_rejected(self):
        sql = (
            "INSERT INTO transactions "
            "(bank, date, raw_description, amount, transaction_hash) "
            "VALUES (?, ?, ?, ?, ?)"
        )
        self.conn.execute(sql, ("ING", "2026-01-01", "TEST ONE", -1000, "samehash"))
        with self.assertRaises(sqlite3.IntegrityError):
            self.conn.execute(sql, ("ING", "2026-01-02", "TEST TWO", 500, "samehash"))

    def test_duplicate_category_name_rejected(self):
        sql = "INSERT INTO categories (name) VALUES (?)"
        self.conn.execute(sql, ("Groceries",))
        with self.assertRaises(sqlite3.IntegrityError):
            self.conn.execute(sql, ("Groceries",))


if __name__ == "__main__":
    unittest.main()
