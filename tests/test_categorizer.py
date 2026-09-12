"""Step 7 tests for categorizer: rule matching, category validation, copies.

Synthetic data only: made-up categories, rules and transactions in a
throwaway SQLite database created with init_db().
"""

import copy
import sqlite3
import tempfile
import unittest
from pathlib import Path

from categorizer import categorize_transaction, categorize_transactions
from database import init_db

CATEGORY_FIELDS = ("merchant", "type", "category", "subcategory")


def txn(**overrides):
    base = {"date": "2026-01-05", "description": "CARD PURCHASE EXAMPLE CAFE MELBOURNE AU",
            "amount": -1200, "balance": 378}
    base.update(overrides)
    return base


class CategorizerTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.db_path = Path(self._tmp.name) / "test.db"
        init_db(self.db_path)
        self.conn = sqlite3.connect(self.db_path)
        self.addCleanup(self.conn.close)
        self.add_category("Eating Out")
        self.add_category("Groceries")

    def add_category(self, name, active=1):
        self.conn.execute("INSERT INTO categories (name, active) VALUES (?, ?)", (name, active))
        self.conn.commit()

    def add_rule(self, pattern, category, merchant=None, type_=None, subcategory=None, active=1):
        self.conn.execute(
            "INSERT INTO rules (pattern, merchant, type, category, subcategory, active)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (pattern, merchant, type_, category, subcategory, active),
        )
        self.conn.commit()

    def assert_needs_review(self, result):
        self.assertTrue(result["needs_review"])
        for field in CATEGORY_FIELDS:
            self.assertIsNone(result[field], field)

    def row_counts(self):
        return tuple(
            self.conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in ("rules", "categories", "transactions", "imports")
        )


class MatchingTests(CategorizerTestCase):
    def test_exact_uppercase_substring_match(self):
        self.add_rule("EXAMPLE CAFE", "Eating Out")
        result = categorize_transaction(self.conn, txn(description="EXAMPLE CAFE"))
        self.assertEqual(result["category"], "Eating Out")
        self.assertFalse(result["needs_review"])

    def test_matching_is_case_insensitive(self):
        self.add_rule("example cafe", "Eating Out")
        for description in ("EXAMPLE CAFE", "Example Cafe", "example cafe", "eXaMpLe CaFe"):
            with self.subTest(description=description):
                result = categorize_transaction(self.conn, txn(description=description))
                self.assertEqual(result["category"], "Eating Out")

    def test_surrounding_text_does_not_prevent_match(self):
        self.add_rule("EXAMPLE CAFE", "Eating Out")
        result = categorize_transaction(
            self.conn, txn(description="Card xx1234 Value Date: 01/01/2026 EXAMPLE CAFE MELBOURNE AU AUS")
        )
        self.assertEqual(result["category"], "Eating Out")

    def test_pattern_is_literal_not_a_wildcard(self):
        self.add_rule("50% OFF_STORE", "Groceries")
        self.assertFalse(categorize_transaction(self.conn, txn(description="50% OFF_STORE X"))["needs_review"])
        self.assertTrue(categorize_transaction(self.conn, txn(description="50 OFF STORE X"))["needs_review"])
        self.add_rule("O'BRIEN", "Groceries")
        self.assertFalse(categorize_transaction(self.conn, txn(description="POS O'BRIEN 12"))["needs_review"])

    def test_pattern_whitespace_is_literal(self):
        self.add_rule(" CAFE", "Eating Out")  # leading space is part of the pattern
        self.assertTrue(categorize_transaction(self.conn, txn(description="XCAFE"))["needs_review"])
        self.assertFalse(categorize_transaction(self.conn, txn(description="X CAFE"))["needs_review"])

    def test_non_matching_pattern(self):
        self.add_rule("EXAMPLE CAFE", "Eating Out")
        self.assert_needs_review(categorize_transaction(self.conn, txn(description="EXAMPLE CAF")))


class RuleValidityTests(CategorizerTestCase):
    def test_inactive_rule_is_ignored(self):
        self.add_rule("EXAMPLE CAFE", "Eating Out", active=0)
        self.assert_needs_review(categorize_transaction(self.conn, txn()))

    def test_missing_category_needs_review(self):
        self.add_rule("EXAMPLE CAFE", "Nonexistent Category")
        self.assert_needs_review(categorize_transaction(self.conn, txn()))

    def test_inactive_category_needs_review(self):
        self.add_category("Retired", active=0)
        self.add_rule("EXAMPLE CAFE", "Retired")
        self.assert_needs_review(categorize_transaction(self.conn, txn()))

    def test_category_name_must_match_exactly(self):
        self.add_rule("EXAMPLE CAFE", "eating out")  # categories has "Eating Out"
        self.assert_needs_review(categorize_transaction(self.conn, txn()))

    def test_inactive_rules_do_not_create_ambiguity(self):
        self.add_rule("EXAMPLE CAFE", "Eating Out", merchant="Example Cafe")
        self.add_rule("EXAMPLE", "Groceries", active=0)
        self.add_rule("CAFE", "Groceries", active=0)
        result = categorize_transaction(self.conn, txn())
        self.assertEqual((result["category"], result["merchant"], result["needs_review"]),
                         ("Eating Out", "Example Cafe", False))

    def test_invalid_category_rule_never_auto_classifies(self):
        self.add_rule("EXAMPLE CAFE", "Nonexistent Category", merchant="Example Cafe", type_="Expense")
        result = categorize_transaction(self.conn, txn())
        self.assert_needs_review(result)
        self.assertIsNone(result["merchant"])
        self.assertIsNone(result["type"])

    def test_invalid_rule_alongside_valid_rule_needs_review(self):
        """A matching rule with a broken category is surfaced, not silently skipped."""
        self.add_rule("EXAMPLE CAFE", "Eating Out")
        self.add_rule("MELBOURNE", "Nonexistent Category")
        self.assert_needs_review(categorize_transaction(self.conn, txn()))

    def test_inactive_category_rule_alongside_valid_rule_needs_review(self):
        self.add_category("Retired", active=0)
        self.add_rule("EXAMPLE CAFE", "Eating Out")
        self.add_rule("MELBOURNE", "Retired")
        self.assert_needs_review(categorize_transaction(self.conn, txn()))


class OutcomeTests(CategorizerTestCase):
    def test_one_valid_rule_applies_all_fields(self):
        self.add_rule("EXAMPLE CAFE", "Eating Out", merchant="Example Cafe", type_="Expense", subcategory="Coffee")
        result = categorize_transaction(self.conn, txn())
        self.assertEqual(result["merchant"], "Example Cafe")
        self.assertEqual(result["type"], "Expense")
        self.assertEqual(result["category"], "Eating Out")
        self.assertEqual(result["subcategory"], "Coffee")
        self.assertIs(result["needs_review"], False)

    def test_rule_merchant_can_be_none(self):
        self.add_rule("EXAMPLE CAFE", "Eating Out", merchant=None, type_="Expense")
        result = categorize_transaction(self.conn, txn())
        self.assertIsNone(result["merchant"])
        self.assertEqual(result["category"], "Eating Out")
        self.assertFalse(result["needs_review"])

    def test_rule_subcategory_can_be_none(self):
        self.add_rule("EXAMPLE CAFE", "Eating Out", subcategory=None)
        result = categorize_transaction(self.conn, txn())
        self.assertIsNone(result["subcategory"])
        self.assertFalse(result["needs_review"])

    def test_no_match_needs_review_with_all_fields_none(self):
        self.add_rule("SOMETHING ELSE", "Groceries")
        result = categorize_transaction(self.conn, txn())
        self.assert_needs_review(result)
        self.assertIs(result["needs_review"], True)

    def test_multiple_valid_matches_need_review(self):
        self.add_rule("EXAMPLE CAFE", "Eating Out", merchant="Example Cafe")
        self.add_rule("MELBOURNE", "Groceries", merchant="Somewhere")
        self.assert_needs_review(categorize_transaction(self.conn, txn()))

    def test_positive_amount_is_not_income_automatically(self):
        result = categorize_transaction(self.conn, txn(amount=250000, description="MADE UP EMPLOYER PAYROLL"))
        self.assert_needs_review(result)
        self.assertEqual(result["amount"], 250000)
        # even when a rule matches, type comes only from the rule
        self.add_rule("EXAMPLE CAFE", "Eating Out", type_=None)
        self.assertIsNone(categorize_transaction(self.conn, txn(amount=5000))["type"])
        self.add_rule("FRIEND REPAYMENT", "Groceries", type_="Friends / Personal Transfers")
        result = categorize_transaction(self.conn, txn(amount=5000, description="FRIEND REPAYMENT"))
        self.assertEqual(result["type"], "Friends / Personal Transfers")

    def test_negative_amount_is_not_expense_automatically(self):
        result = categorize_transaction(self.conn, txn(amount=-999))
        self.assert_needs_review(result)
        self.assertIsNone(result["type"])
        self.add_rule("EXAMPLE CAFE", "Eating Out", type_=None)
        self.assertIsNone(categorize_transaction(self.conn, txn(amount=-999))["type"])
        self.add_rule("REFUND SHOP", "Groceries", type_="Refund")
        self.assertEqual(categorize_transaction(self.conn, txn(amount=-999, description="REFUND SHOP"))["type"], "Refund")

    def test_description_preserved_exactly(self):
        self.add_rule("example cafe", "Eating Out")
        original = "  Card xx1234  eXample CAFE   Melbourne  "
        result = categorize_transaction(self.conn, txn(description=original))
        self.assertEqual(result["description"], original)
        self.assertFalse(result["needs_review"])

    def test_input_dictionary_not_mutated_and_result_is_a_copy(self):
        self.add_rule("EXAMPLE CAFE", "Eating Out", type_="Expense")
        original = txn()
        snapshot = copy.deepcopy(original)
        result = categorize_transaction(self.conn, original)
        self.assertEqual(original, snapshot)
        self.assertIsNot(result, original)
        for key in snapshot:
            self.assertEqual(result[key], snapshot[key])
        self.assertEqual(set(result), set(snapshot) | set(CATEGORY_FIELDS) | {"needs_review"})
        self.assertIs(type(result["amount"]), int)
        self.assertIs(type(result["balance"]), int)


class BatchAndAccessTests(CategorizerTestCase):
    def test_batch_preserves_input_order(self):
        self.add_rule("EXAMPLE CAFE", "Eating Out")
        self.add_rule("SUPERMARKET", "Groceries")
        batch = [txn(description="EXAMPLE CAFE"), txn(description="NO RULE HERE"),
                 txn(description="SUPERMARKET 12"), txn(description="EXAMPLE CAFE SUPERMARKET")]
        results = categorize_transactions(self.conn, batch)
        self.assertEqual([r["description"] for r in results], [t["description"] for t in batch])
        self.assertEqual([r["category"] for r in results], ["Eating Out", None, "Groceries", None])
        self.assertEqual([r["needs_review"] for r in results], [False, True, False, True])
        self.assertEqual(categorize_transactions(self.conn, []), [])

    def test_caller_connection_row_factory_does_not_matter(self):
        self.add_rule("EXAMPLE CAFE", "Eating Out", merchant="Example Cafe")
        for factory in (sqlite3.Row, lambda cur, row: {d[0]: v for d, v in zip(cur.description, row)}):
            with self.subTest(factory=factory):
                conn = sqlite3.connect(self.db_path)
                self.addCleanup(conn.close)
                conn.row_factory = factory
                result = categorize_transaction(conn, txn())
                self.assertEqual((result["category"], result["merchant"], result["needs_review"]),
                                 ("Eating Out", "Example Cafe", False))

    def test_accepts_db_path_and_is_read_only(self):
        self.add_rule("EXAMPLE CAFE", "Eating Out")
        before = self.row_counts()
        result = categorize_transaction(self.db_path, txn())
        self.assertEqual(result["category"], "Eating Out")
        self.assertEqual(self.row_counts(), before)
        with self.assertRaises(FileNotFoundError):
            categorize_transaction(Path(self._tmp.name) / "missing.db", txn())


if __name__ == "__main__":
    unittest.main()
