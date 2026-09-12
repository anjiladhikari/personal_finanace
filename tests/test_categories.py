"""Step 11 tests for categories: add, deactivate, activate, list. Synthetic names only."""

import sqlite3
import tempfile
import unittest
from pathlib import Path

from categories import CategoryError, activate_category, add_category, deactivate_category, list_categories
from database import init_db


class CategoriesTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.db_path = Path(self._tmp.name) / "test.db"
        init_db(self.db_path)
        self.conn = sqlite3.connect(self.db_path)
        self.addCleanup(self.conn.close)

    def raw(self):
        return self.conn.execute("SELECT id, name, active FROM categories ORDER BY id").fetchall()

    def other_counts(self):
        return tuple(self.conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                     for t in ("transactions", "rules", "imports", "net_worth"))


class AddTests(CategoriesTestCase):
    def test_add_is_active_by_default(self):
        record = add_category(self.conn, "Travel")
        self.assertEqual((record["name"], record["active"]), ("Travel", True))
        self.assertIsInstance(record["id"], int)
        self.assertIsInstance(record["created_at"], str)
        self.assertEqual(self.raw(), [(record["id"], "Travel", 1)])

    def test_surrounding_whitespace_trimmed_only(self):
        record = add_category(self.conn, "  Eating  Out \n")
        self.assertEqual(record["name"], "Eating  Out")  # inner spacing and case untouched

    def test_invalid_names_rejected(self):
        for bad in ("", "   ", "\t\n", None, 5, ["Travel"], b"Travel"):
            with self.subTest(bad=bad), self.assertRaises(CategoryError):
                add_category(self.conn, bad)
        self.assertEqual(self.raw(), [])

    def test_exact_and_case_insensitive_duplicates_not_inserted(self):
        add_category(self.conn, "Travel")
        for dup in ("Travel", "travel", "TRAVEL", " tRaVeL "):
            with self.subTest(dup=dup), self.assertRaises(CategoryError):
                add_category(self.conn, dup)
        self.assertEqual(len(self.raw()), 1)

    def test_add_reactivates_inactive_category_keeping_stored_name(self):
        original = add_category(self.conn, "Travel")
        deactivate_category(self.conn, "Travel")
        record = add_category(self.conn, "TRAVEL")
        self.assertEqual((record["id"], record["name"], record["active"]), (original["id"], "Travel", True))
        self.assertEqual(self.raw(), [(original["id"], "Travel", 1)])

    def test_unicode_case_variants_are_one_category(self):
        add_category(self.conn, "Café")
        with self.assertRaises(CategoryError):
            add_category(self.conn, "CAFÉ")
        self.assertEqual(len(self.raw()), 1)


class DeactivateActivateTests(CategoriesTestCase):
    def setUp(self):
        super().setUp()
        self.travel = add_category(self.conn, "Travel")

    def test_deactivate(self):
        record = deactivate_category(self.conn, "Travel")
        self.assertEqual((record["id"], record["name"], record["active"]), (self.travel["id"], "Travel", False))
        self.assertEqual(self.raw(), [(self.travel["id"], "Travel", 0)])  # row kept, name kept

    def test_deactivate_lookup_case_insensitive_and_trimmed(self):
        record = deactivate_category(self.conn, "  tRAVEL ")
        self.assertEqual(record["name"], "Travel")
        self.assertEqual(self.raw(), [(self.travel["id"], "Travel", 0)])

    def test_deactivate_already_inactive_is_idempotent(self):
        deactivate_category(self.conn, "Travel")
        record = deactivate_category(self.conn, "Travel")
        self.assertEqual(record["active"], False)
        self.assertEqual(self.raw(), [(self.travel["id"], "Travel", 0)])

    def test_deactivate_missing_raises(self):
        with self.assertRaises(CategoryError):
            deactivate_category(self.conn, "Gym")
        with self.assertRaises(CategoryError):
            deactivate_category(self.conn, "")

    def test_activate(self):
        deactivate_category(self.conn, "Travel")
        record = activate_category(self.conn, "travel")
        self.assertEqual((record["id"], record["name"], record["active"]), (self.travel["id"], "Travel", True))
        self.assertEqual(self.raw(), [(self.travel["id"], "Travel", 1)])

    def test_activate_already_active_is_idempotent(self):
        self.assertEqual(activate_category(self.conn, "TRAVEL")["active"], True)
        self.assertEqual(self.raw(), [(self.travel["id"], "Travel", 1)])

    def test_activate_missing_raises_and_does_not_create(self):
        with self.assertRaises(CategoryError):
            activate_category(self.conn, "Gym")
        self.assertEqual(len(self.raw()), 1)


class ListTests(CategoriesTestCase):
    def setUp(self):
        super().setUp()
        for name in ("travel", "Coffee", "Gym", "coffee shop", "Eating Out"):
            add_category(self.conn, name)
        deactivate_category(self.conn, "Gym")

    def test_default_lists_active_only_in_case_insensitive_order(self):
        self.assertEqual([c["name"] for c in list_categories(self.conn)],
                         ["Coffee", "coffee shop", "Eating Out", "travel"])
        self.assertTrue(all(c["active"] is True for c in list_categories(self.conn)))

    def test_include_inactive_lists_all(self):
        records = list_categories(self.conn, include_inactive=True)
        self.assertEqual([c["name"] for c in records], ["Coffee", "coffee shop", "Eating Out", "Gym", "travel"])
        self.assertEqual([c["active"] for c in records], [True, True, True, False, True])
        self.assertEqual(set(records[0]), {"id", "name", "active", "created_at"})

    def test_ordering_ties_broken_by_id(self):
        # Rows that differ only by case can only get in via raw SQL; listing stays deterministic.
        self.conn.execute("DELETE FROM categories")
        self.conn.execute("INSERT INTO categories (name) VALUES ('alpha')")
        self.conn.execute("INSERT INTO categories (name) VALUES ('Alpha')")
        self.conn.execute("INSERT INTO categories (name) VALUES ('ALPHA')")
        self.conn.commit()
        records = list_categories(self.conn)
        self.assertEqual([c["name"] for c in records], ["alpha", "Alpha", "ALPHA"])
        self.assertEqual([c["id"] for c in records], sorted(c["id"] for c in records))


class DatabaseBehaviourTests(CategoriesTestCase):
    def test_other_tables_untouched(self):
        before = self.other_counts()
        add_category(self.conn, "Travel")
        deactivate_category(self.conn, "Travel")
        activate_category(self.conn, "Travel")
        list_categories(self.conn, include_inactive=True)
        self.assertEqual(self.other_counts(), before)

    def test_path_and_connection_access_both_commit(self):
        add_category(self.db_path, "Travel")
        add_category(self.conn, "Gym")
        deactivate_category(self.db_path, "Gym")
        other = sqlite3.connect(self.db_path)
        self.addCleanup(other.close)
        self.assertEqual(other.execute("SELECT name, active FROM categories ORDER BY name").fetchall(),
                         [("Gym", 0), ("Travel", 1)])
        self.assertEqual([c["name"] for c in list_categories(self.db_path)], ["Travel"])
        with self.assertRaises(FileNotFoundError):
            add_category(Path(self._tmp.name) / "missing.db", "Travel")

    def test_caller_transaction_not_committed(self):
        self.conn.execute("INSERT INTO imports (bank, original_filename, file_hash) VALUES ('ing', 'x.pdf', 'h')")
        self.assertTrue(self.conn.in_transaction)
        add_category(self.conn, "Travel")
        deactivate_category(self.conn, "Travel")
        self.assertTrue(self.conn.in_transaction)
        self.conn.rollback()
        self.assertEqual(self.raw(), [])
        self.assertEqual(self.other_counts(), (0, 0, 0, 0))

    def test_sql_values_are_parameterised(self):
        awkward = "O'Brien's \"Cafe\"; DROP TABLE categories; -- 50% off_"
        record = add_category(self.conn, awkward)
        self.assertEqual(record["name"], awkward)
        self.assertEqual(deactivate_category(self.conn, awkward)["active"], False)
        self.assertEqual(activate_category(self.conn, awkward.upper())["active"], True)
        self.assertEqual([c["name"] for c in list_categories(self.conn)], [awkward])
        with self.assertRaises(CategoryError):
            deactivate_category(self.conn, "x' OR 1=1 --")


class IntegrationTests(CategoriesTestCase):
    def test_created_category_is_usable_until_deactivated(self):
        from categorizer import categorize_transaction
        from review import ReviewValidationError, create_review_item, update_review_item
        from transaction_store import SaveValidationError, save_review_item

        add_category(self.conn, "Travel")
        self.conn.execute("INSERT INTO rules (pattern, category, active) VALUES ('EXAMPLE AIRLINE', 'Travel', 1)")
        self.conn.commit()
        parsed = {"date": "2026-01-05", "description": "EXAMPLE AIRLINE 123", "amount": -15000, "balance": 100}
        self.assertEqual(categorize_transaction(self.conn, parsed)["category"], "Travel")

        item = create_review_item({**parsed, "bank": "ing", "transaction_hash": "a" * 64,
                                   "is_internal": False, "is_duplicate": False})
        item = update_review_item(self.conn, item, category="Travel")
        self.assertEqual(item["category"], "Travel")
        approved = {**item, "decision": "approved"}
        self.assertEqual(save_review_item(self.conn, approved), "saved")

        deactivate_category(self.conn, "travel")
        self.assertTrue(categorize_transaction(self.conn, parsed)["needs_review"])
        with self.assertRaises(ReviewValidationError):
            update_review_item(self.conn, item, category="Travel")
        with self.assertRaises(SaveValidationError):
            save_review_item(self.conn, {**approved, "transaction_hash": "b" * 64})


if __name__ == "__main__":
    unittest.main()
