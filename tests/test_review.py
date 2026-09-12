"""Step 9 tests for review: review items, edits, category validation, approve/reject.

Synthetic data only, with a throwaway SQLite database created by init_db().
"""

import copy
import sqlite3
import tempfile
import unittest
from pathlib import Path

from database import init_db
from review import (
    ReviewValidationError,
    approve_review_item,
    create_review_item,
    create_review_items,
    reject_review_item,
    update_review_item,
)

RAW = {"date": "2026-01-05", "description": "  EXAMPLE SHOP  SUBURB xx0000 ", "amount": -1200, "balance": 378}


def categorised(**overrides):
    """A made-up transaction as it leaves Steps 6-8."""
    base = {
        **RAW,
        "merchant": None, "type": None, "category": None, "subcategory": None, "needs_review": True,
        "is_internal": False,
        "transaction_hash": "f" * 64, "occurrence": 2, "in_database": False, "in_batch": False,
        "is_duplicate": False,
    }
    base.update(overrides)
    return base


class ReviewTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.db_path = Path(self._tmp.name) / "test.db"
        init_db(self.db_path)
        self.conn = sqlite3.connect(self.db_path)
        self.addCleanup(self.conn.close)
        self.conn.execute("INSERT INTO categories (name, active) VALUES (?, ?)", ("Groceries", 1))
        self.conn.execute("INSERT INTO categories (name, active) VALUES (?, ?)", ("Retired", 0))
        self.conn.commit()

    def row_counts(self):
        return tuple(
            self.conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in ("transactions", "categories", "rules", "imports")
        )


class CreateTests(ReviewTestCase):
    def test_preserves_original_fields_and_adds_defaults(self):
        transaction = categorised(merchant="Example Shop", type="Expense", category="Groceries", needs_review=False)
        snapshot = copy.deepcopy(transaction)
        item = create_review_item(transaction)
        self.assertEqual(transaction, snapshot)
        self.assertIsNot(item, transaction)
        for key, value in snapshot.items():
            self.assertEqual(item[key], value, key)
        self.assertIs(item["remember_choice"], False)
        self.assertIsNone(item["decision"])
        self.assertEqual(set(item), set(snapshot) | {"remember_choice", "decision"})

    def test_upstream_metadata_preserved(self):
        item = create_review_item(categorised(is_duplicate=True, is_internal=True, needs_review=False, occurrence=3))
        self.assertEqual(item["transaction_hash"], "f" * 64)
        self.assertEqual(item["occurrence"], 3)
        self.assertIs(item["is_duplicate"], True)
        self.assertIs(item["is_internal"], True)
        self.assertIs(item["needs_review"], False)
        self.assertIsNone(item["decision"])  # duplicates/internals are not auto-decided

    def test_existing_review_state_is_kept_not_reset(self):
        item = create_review_item(categorised(remember_choice=True, decision="approved"))
        self.assertIs(item["remember_choice"], True)
        self.assertEqual(item["decision"], "approved")

    def test_editable_fields_default_to_none_when_absent(self):
        item = create_review_item(dict(RAW))
        self.assertEqual((item["merchant"], item["type"], item["category"], item["subcategory"]), (None,) * 4)

    def test_invalid_incoming_state_is_rejected(self):
        with self.assertRaises(ReviewValidationError):
            create_review_item(categorised(decision="maybe"))
        with self.assertRaises(ReviewValidationError):
            create_review_item(categorised(remember_choice="yes"))
        with self.assertRaises(ReviewValidationError):
            create_review_item({"description": "no raw amount"})

    def test_no_amount_sign_inference(self):
        for amount in (250000, -250000, 0):
            with self.subTest(amount=amount):
                item = create_review_item(categorised(amount=amount))
                self.assertIsNone(item["type"])
                self.assertEqual(item["amount"], amount)

    def test_batch_preserves_order(self):
        batch = [categorised(description=f"T{i}", amount=-i) for i in range(5)]
        items = create_review_items(batch)
        self.assertEqual([i["description"] for i in items], [t["description"] for t in batch])
        self.assertTrue(all(i["decision"] is None and i["remember_choice"] is False for i in items))
        self.assertEqual(create_review_items([]), [])


class UpdateTests(ReviewTestCase):
    def setUp(self):
        super().setUp()
        self.item = create_review_item(categorised())
        self.snapshot = copy.deepcopy(self.item)

    def test_edit_each_field(self):
        updated = update_review_item(self.conn, self.item, merchant="Example Shop")
        self.assertEqual(updated["merchant"], "Example Shop")
        updated = update_review_item(self.conn, updated, type="Expense")
        self.assertEqual(updated["type"], "Expense")
        updated = update_review_item(self.conn, updated, category="Groceries")
        self.assertEqual(updated["category"], "Groceries")
        updated = update_review_item(self.conn, updated, subcategory="Fruit")
        self.assertEqual(updated["subcategory"], "Fruit")
        self.assertIs(updated["needs_review"], True)  # automation history unchanged by edits
        self.assertIsNone(updated["decision"])

    def test_fields_can_be_set_to_none(self):
        filled = update_review_item(self.conn, self.item, merchant="M", type="Expense",
                                    category="Groceries", subcategory="S")
        cleared = update_review_item(self.conn, filled, merchant=None, type=None, category=None, subcategory=None)
        self.assertEqual((cleared["merchant"], cleared["type"], cleared["category"], cleared["subcategory"]),
                         (None,) * 4)

    def test_edited_values_are_stored_verbatim(self):
        """No auto-cleaning: whitespace and case of an explicit user value are kept."""
        updated = update_review_item(self.conn, self.item, merchant="  example shop ", type=" Expense",
                                     subcategory="fruit  ")
        self.assertEqual((updated["merchant"], updated["type"], updated["subcategory"]),
                         ("  example shop ", " Expense", "fruit  "))

    def test_unmentioned_fields_are_untouched(self):
        filled = update_review_item(self.conn, self.item, merchant="M", type="Income")
        updated = update_review_item(self.conn, filled, subcategory="S")
        self.assertEqual((updated["merchant"], updated["type"], updated["subcategory"]), ("M", "Income", "S"))

    def test_inactive_category_rejected(self):
        with self.assertRaises(ReviewValidationError):
            update_review_item(self.conn, self.item, category="Retired")

    def test_nonexistent_category_rejected(self):
        with self.assertRaises(ReviewValidationError):
            update_review_item(self.conn, self.item, category="No Such Category")
        with self.assertRaises(ReviewValidationError):
            update_review_item(self.conn, self.item, category="groceries")  # exact name only

    def test_category_none_allowed(self):
        self.assertIsNone(update_review_item(self.conn, self.item, category=None)["category"])

    def test_category_validation_works_with_db_path(self):
        self.assertEqual(update_review_item(self.db_path, self.item, category="Groceries")["category"], "Groceries")
        with self.assertRaises(ReviewValidationError):
            update_review_item(self.db_path, self.item, category="Retired")

    def test_failed_edit_leaves_item_unchanged(self):
        with self.assertRaises(ReviewValidationError):
            update_review_item(self.conn, self.item, merchant="M", category="Retired")
        self.assertEqual(self.item, self.snapshot)

    def test_invalid_editable_types_rejected(self):
        for kwargs in ({"merchant": 5}, {"type": ["Expense"]}, {"category": 1}, {"subcategory": b"x"},
                       {"merchant": True}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ReviewValidationError):
                update_review_item(self.conn, self.item, **kwargs)

    def test_remember_choice_true_and_false_preserved(self):
        remembered = update_review_item(self.conn, self.item, remember_choice=True)
        self.assertIs(remembered["remember_choice"], True)
        self.assertIs(approve_review_item(remembered)["remember_choice"], True)
        self.assertIs(update_review_item(self.conn, remembered, merchant="M")["remember_choice"], True)
        forgotten = update_review_item(self.conn, remembered, remember_choice=False)
        self.assertIs(forgotten["remember_choice"], False)
        self.assertIs(reject_review_item(forgotten)["remember_choice"], False)

    def test_non_bool_remember_choice_rejected(self):
        for bad in (1, 0, "true", None, "yes"):
            with self.subTest(bad=bad), self.assertRaises(ReviewValidationError):
                update_review_item(self.conn, self.item, remember_choice=bad)

    def test_remember_choice_creates_no_rule(self):
        before = self.row_counts()
        update_review_item(self.conn, self.item, merchant="M", category="Groceries", remember_choice=True)
        self.assertEqual(self.row_counts(), before)

    def test_raw_fields_cannot_be_edited(self):
        for field in ("description", "date", "amount", "balance"):
            with self.subTest(field=field), self.assertRaises(TypeError):
                update_review_item(self.conn, self.item, **{field: "changed"})
        with self.assertRaises(TypeError):
            update_review_item(self.conn, self.item, decision="approved")
        updated = update_review_item(self.conn, self.item, merchant="M", type="T", category="Groceries",
                                     subcategory="S", remember_choice=True)
        for field in ("description", "date", "amount", "balance"):
            self.assertEqual(updated[field], RAW[field], field)
        self.assertEqual(updated["description"], "  EXAMPLE SHOP  SUBURB xx0000 ")

    def test_update_does_not_mutate_original(self):
        update_review_item(self.conn, self.item, merchant="M", category="Groceries", remember_choice=True)
        self.assertEqual(self.item, self.snapshot)

    def test_tampered_decision_is_rejected(self):
        tampered = {**self.item, "decision": "pending"}
        with self.assertRaises(ReviewValidationError):
            update_review_item(self.conn, tampered, merchant="M")
        with self.assertRaises(ReviewValidationError):
            approve_review_item(tampered)

    def test_no_sqlite_writes(self):
        before = self.row_counts()
        item = update_review_item(self.conn, self.item, merchant="M", type="Expense", category="Groceries",
                                  subcategory="S", remember_choice=True)
        approve_review_item(item)
        reject_review_item(item)
        create_review_items([categorised(), categorised()])
        self.assertEqual(self.row_counts(), before)
        self.assertFalse(self.conn.in_transaction)


class DecisionTests(ReviewTestCase):
    def setUp(self):
        super().setUp()
        self.item = create_review_item(categorised(merchant="M", type="Expense", category="Groceries",
                                                   needs_review=False, remember_choice=True))
        self.snapshot = copy.deepcopy(self.item)

    def test_approve(self):
        approved = approve_review_item(self.item)
        self.assertEqual(approved["decision"], "approved")
        self.assertIsNot(approved, self.item)
        self.assertEqual(self.item, self.snapshot)
        self.assertEqual({k: v for k, v in approved.items() if k != "decision"},
                         {k: v for k, v in self.snapshot.items() if k != "decision"})

    def test_reject(self):
        rejected = reject_review_item(self.item)
        self.assertEqual(rejected["decision"], "rejected")
        self.assertIsNot(rejected, self.item)
        self.assertEqual(self.item, self.snapshot)
        self.assertEqual({k: v for k, v in rejected.items() if k != "decision"},
                         {k: v for k, v in self.snapshot.items() if k != "decision"})

    def test_needs_review_is_independent_of_decision(self):
        pending = create_review_item(categorised(needs_review=True))
        self.assertIs(approve_review_item(pending)["needs_review"], True)
        self.assertIs(reject_review_item(pending)["needs_review"], True)
        self.assertIs(approve_review_item(self.item)["needs_review"], False)

    def test_decision_can_be_changed_and_upstream_flags_survive(self):
        item = create_review_item(categorised(is_internal=True, is_duplicate=True))
        approved = approve_review_item(item)
        rejected = reject_review_item(approved)
        self.assertEqual((approved["decision"], rejected["decision"]), ("approved", "rejected"))
        for decided in (approved, rejected):
            self.assertIs(decided["is_internal"], True)
            self.assertIs(decided["is_duplicate"], True)
            self.assertEqual(decided["transaction_hash"], "f" * 64)
            self.assertEqual(decided["occurrence"], 2)
            self.assertEqual(decided["description"], RAW["description"])


if __name__ == "__main__":
    unittest.main()
