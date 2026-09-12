"""Step 10 tests for transaction_store: saving approved transactions. Synthetic data only."""

import copy
import sqlite3
import tempfile
import unittest
from pathlib import Path

from database import init_db
from transaction_store import SaveValidationError, save_review_item, save_review_items

COLUMNS = ("bank", "date", "raw_description", "merchant", "amount", "balance", "type", "category",
           "subcategory", "transaction_hash")


def item(**overrides):
    """A made-up approved, non-internal, non-duplicate review item."""
    base = {
        "bank": "commbank", "date": "2026-01-05", "description": "  EXAMPLE SHOP  SUBURB xx0000 ",
        "amount": -1200, "balance": 378,
        "merchant": "Example Shop", "type": "Expense", "category": "Groceries", "subcategory": "Fruit",
        "needs_review": False, "is_internal": False,
        "transaction_hash": "a" * 64, "occurrence": 2, "in_database": False, "in_batch": False,
        "is_duplicate": False, "remember_choice": False, "decision": "approved",
    }
    base.update(overrides)
    return base


class StoreTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.db_path = Path(self._tmp.name) / "test.db"
        init_db(self.db_path)
        self.conn = sqlite3.connect(self.db_path)
        self.addCleanup(self.conn.close)
        self.conn.execute("INSERT INTO categories (name, active) VALUES ('Groceries', 1)")
        self.conn.execute("INSERT INTO categories (name, active) VALUES ('Retired', 0)")
        self.conn.commit()

    def rows(self):
        return self.conn.execute(
            f"SELECT {', '.join(COLUMNS)} FROM transactions ORDER BY id"
        ).fetchall()

    def counts(self):
        return tuple(self.conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                     for t in ("transactions", "rules", "imports", "categories"))


class SaveTests(StoreTestCase):
    def test_approved_normal_transaction_is_inserted_with_exact_fields(self):
        self.assertEqual(save_review_item(self.conn, item()), "saved")
        [row] = self.rows()
        self.assertEqual(row, ("commbank", "2026-01-05", "  EXAMPLE SHOP  SUBURB xx0000 ", "Example Shop",
                               -1200, 378, "Expense", "Groceries", "Fruit", "a" * 64))
        self.assertIs(type(row[4]), int)
        self.assertIs(type(row[5]), int)

    def test_none_balance_and_none_optional_fields_preserved(self):
        save_review_item(self.conn, item(balance=None, merchant=None, type=None, category=None, subcategory=None))
        [row] = self.rows()
        self.assertEqual(row[3:9], (None, -1200, None, None, None, None))

    def test_bank_is_normalised_but_nothing_else_is(self):
        save_review_item(self.conn, item(bank=" ING ", merchant=" example shop ", type="expense "))
        [row] = self.rows()
        self.assertEqual((row[0], row[3], row[6]), ("ing", " example shop ", "expense "))

    def test_no_review_only_fields_and_no_occurrence_column(self):
        save_review_item(self.conn, item())
        columns = {r[1] for r in self.conn.execute("PRAGMA table_info(transactions)")}
        for field in ("decision", "remember_choice", "needs_review", "is_internal", "is_duplicate",
                      "in_database", "in_batch", "occurrence"):
            self.assertNotIn(field, columns)

    def test_no_sign_inference_and_values_saved_exactly(self):
        save_review_item(self.conn, item(amount=250000, type=None, transaction_hash="b" * 64))
        save_review_item(self.conn, item(amount=-250000, type="Refund", transaction_hash="c" * 64))
        rows = self.rows()
        self.assertEqual([(r[4], r[6]) for r in rows], [(250000, None), (-250000, "Refund")])

    def test_parameterised_sql_round_trips_awkward_text(self):
        awkward = "O'BRIEN's \"SHOP\"; DROP TABLE transactions; -- 50% off_"
        save_review_item(self.conn, item(description=awkward, merchant=awkward, subcategory=awkward))
        [row] = self.rows()
        self.assertEqual((row[2], row[3], row[8]), (awkward, awkward, awkward))


class SkipTests(StoreTestCase):
    def test_rejected_not_saved(self):
        self.assertEqual(save_review_item(self.conn, item(decision="rejected")), "rejected")
        self.assertEqual(self.rows(), [])

    def test_undecided_not_saved(self):
        self.assertEqual(save_review_item(self.conn, item(decision=None)), "undecided")
        self.assertEqual(self.rows(), [])

    def test_approved_internal_transfer_not_saved(self):
        self.assertEqual(save_review_item(self.conn, item(is_internal=True, type="Internal Transfer")), "internal")
        self.assertEqual(self.rows(), [])

    def test_approved_duplicate_not_saved(self):
        self.assertEqual(save_review_item(self.conn, item(is_duplicate=True)), "duplicate")
        self.assertEqual(self.rows(), [])

    def test_skipped_rows_are_not_validated_or_mutated(self):
        bad_but_rejected = item(decision="rejected", amount="oops", bank=None)
        snapshot = copy.deepcopy(bad_but_rejected)
        self.assertEqual(save_review_item(self.conn, bad_but_rejected), "rejected")
        self.assertEqual(bad_but_rejected, snapshot)

    def test_missing_flags_are_not_guessed(self):
        for missing in ("is_internal", "is_duplicate"):
            with self.subTest(missing=missing):
                broken = item()
                del broken[missing]
                with self.assertRaises(SaveValidationError):
                    save_review_item(self.conn, broken)
        self.assertEqual(self.rows(), [])


class ValidationTests(StoreTestCase):
    def assert_rejected(self, **overrides):
        with self.assertRaises(SaveValidationError):
            save_review_item(self.conn, item(**overrides))
        self.assertEqual(self.rows(), [])

    def test_missing_or_unsupported_bank(self):
        broken = item()
        del broken["bank"]
        with self.assertRaises(SaveValidationError):
            save_review_item(self.conn, broken)
        for bank in ("westpac", "", None, 3):
            with self.subTest(bank=bank):
                self.assert_rejected(bank=bank)

    def test_invalid_amount_and_balance(self):
        for amount in (-12.0, "-1200", True, None):
            with self.subTest(amount=amount):
                self.assert_rejected(amount=amount)
        for balance in (3.78, "378", False):
            with self.subTest(balance=balance):
                self.assert_rejected(balance=balance)

    def test_invalid_text_fields(self):
        self.assert_rejected(date=20260105)
        self.assert_rejected(description=None)
        self.assert_rejected(merchant=5)
        self.assert_rejected(type=["Expense"])
        self.assert_rejected(subcategory=b"x")

    def test_invalid_transaction_hash(self):
        for bad in ("A" * 64, "a" * 63, "g" * 64, "", None, 12345, "a" * 65):
            with self.subTest(bad=bad):
                self.assert_rejected(transaction_hash=bad)

    def test_category_must_exist_and_be_active(self):
        self.assert_rejected(category="No Such Category")
        self.assert_rejected(category="Retired")
        self.assert_rejected(category="groceries")  # exact name
        self.assertEqual(save_review_item(self.conn, item(category=None)), "saved")


class BatchTests(StoreTestCase):
    def test_batch_mixed_outcomes_and_order(self):
        batch = [
            item(transaction_hash="1" * 64),
            item(decision="rejected", transaction_hash="2" * 64),
            item(decision=None, transaction_hash="3" * 64),
            item(is_internal=True, transaction_hash="4" * 64),
            item(is_duplicate=True, transaction_hash="5" * 64),
            item(transaction_hash="6" * 64, description="SECOND"),
        ]
        result = save_review_items(self.conn, batch)
        self.assertEqual(result, {"saved": [0, 5], "skipped_rejected": [1], "skipped_undecided": [2],
                                  "skipped_internal": [3], "skipped_duplicate": [4], "conflict": []})
        self.assertEqual([r[9] for r in self.rows()], ["1" * 64, "6" * 64])
        self.assertEqual(save_review_items(self.conn, []), {"saved": [], "skipped_rejected": [],
                                                            "skipped_undecided": [], "skipped_internal": [],
                                                            "skipped_duplicate": [], "conflict": []})

    def test_unique_conflict_does_not_overwrite_existing_row(self):
        save_review_item(self.conn, item(description="ORIGINAL", merchant="First"))
        before = self.rows()
        status = save_review_item(self.conn, item(description="LATER", merchant="Second"))  # same hash
        self.assertEqual(status, "conflict")
        self.assertEqual(self.rows(), before)
        result = save_review_items(self.conn, [item(transaction_hash="9" * 64), item()])
        self.assertEqual((result["saved"], result["conflict"]), ([0], [1]))
        self.assertEqual(len(self.rows()), 2)

    def test_invalid_eligible_row_aborts_whole_batch_before_writing(self):
        save_review_item(self.conn, item(transaction_hash="0" * 64, description="PRE-EXISTING"))
        before = self.rows()
        batch = [item(transaction_hash="1" * 64), item(transaction_hash="2" * 64, amount="bad"),
                 item(transaction_hash="3" * 64)]
        snapshot = copy.deepcopy(batch)
        with self.assertRaises(SaveValidationError):
            save_review_items(self.conn, batch)
        self.assertEqual(self.rows(), before)
        self.assertEqual(batch, snapshot)
        self.assertFalse(self.conn.in_transaction)

    def test_unexpected_db_error_rolls_back_batch(self):
        self.conn.execute(
            "CREATE TRIGGER boom BEFORE INSERT ON transactions WHEN NEW.raw_description = 'BOOM' "
            "BEGIN SELECT RAISE(ABORT, 'boom'); END"
        )
        self.conn.commit()
        batch = [item(transaction_hash="1" * 64), item(transaction_hash="2" * 64, description="BOOM"),
                 item(transaction_hash="3" * 64)]
        with self.assertRaises(sqlite3.IntegrityError):
            save_review_items(self.conn, batch)
        self.assertEqual(self.rows(), [])
        self.assertFalse(self.conn.in_transaction)
        # the connection is still usable and a later good batch saves normally
        self.assertEqual(save_review_items(self.conn, [item(transaction_hash="7" * 64)])["saved"], [0])

    def test_skipped_rows_do_not_cause_rollback(self):
        batch = [item(transaction_hash="1" * 64), item(decision="rejected", transaction_hash="2" * 64),
                 item(is_internal=True, transaction_hash="3" * 64), item(transaction_hash="4" * 64)]
        result = save_review_items(self.conn, batch)
        self.assertEqual(result["saved"], [0, 3])
        self.assertEqual(len(self.rows()), 2)

    def test_inputs_never_mutated(self):
        batch = [item(), item(decision="rejected", transaction_hash="2" * 64), item(is_duplicate=True)]
        snapshot = copy.deepcopy(batch)
        save_review_items(self.conn, batch)
        self.assertEqual(batch, snapshot)

    def test_remember_choice_creates_no_rule_and_imports_untouched(self):
        before = self.counts()
        save_review_item(self.conn, item(remember_choice=True))
        after = self.counts()
        self.assertEqual(after, (before[0] + 1, before[1], before[2], before[3]))

    def test_db_path_and_connection_both_commit(self):
        self.assertEqual(save_review_item(self.db_path, item(transaction_hash="1" * 64)), "saved")
        self.assertEqual(save_review_item(self.conn, item(transaction_hash="2" * 64)), "saved")
        other = sqlite3.connect(self.db_path)
        self.addCleanup(other.close)
        self.assertEqual(other.execute("SELECT COUNT(*) FROM transactions").fetchone()[0], 2)
        with self.assertRaises(FileNotFoundError):
            save_review_item(Path(self._tmp.name) / "missing.db", item())

    def test_nests_inside_a_caller_transaction(self):
        self.conn.execute("INSERT INTO imports (bank, original_filename, file_hash) VALUES ('ing', 'x.pdf', 'h')")
        self.assertTrue(self.conn.in_transaction)
        save_review_items(self.conn, [item()])
        self.assertTrue(self.conn.in_transaction)  # not committed behind the caller's back
        self.conn.rollback()
        self.assertEqual(self.counts(), (0, 0, 0, 2))


if __name__ == "__main__":
    unittest.main()
