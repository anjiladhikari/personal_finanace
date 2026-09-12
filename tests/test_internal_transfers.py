"""Step 8 tests for internal_transfers: marking and separation. Synthetic data only."""

import copy
import unittest

from internal_transfers import (
    is_internal_transfer,
    mark_internal_transfer,
    mark_internal_transfers,
    split_internal_transfers,
)


def categorised(**overrides):
    """A made-up transaction as returned by Step 7."""
    base = {
        "date": "2026-01-05", "description": "EXAMPLE SHOP SUBURB", "amount": -1200, "balance": 378,
        "merchant": "Example Shop", "type": "Expense", "category": "Shopping", "subcategory": None,
        "needs_review": False,
    }
    base.update(overrides)
    return base


class MarkingTests(unittest.TestCase):
    def test_internal_transfer_type_is_internal(self):
        result = mark_internal_transfer(categorised(type="Internal Transfer", merchant="Own Savings", category=None))
        self.assertIs(result["is_internal"], True)

    def test_case_insensitive(self):
        for type_ in ("internal transfer", "INTERNAL TRANSFER", "Internal transfer", "iNtErNaL tRaNsFeR"):
            with self.subTest(type=type_):
                self.assertTrue(mark_internal_transfer(categorised(type=type_))["is_internal"])

    def test_surrounding_whitespace_ignored(self):
        for type_ in (" Internal Transfer", "Internal Transfer ", "\tInternal Transfer\n"):
            with self.subTest(type=repr(type_)):
                result = mark_internal_transfer(categorised(type=type_))
                self.assertTrue(result["is_internal"])
                self.assertEqual(result["type"], type_)  # displayed type text untouched

    def test_other_types_are_not_internal(self):
        for type_ in ("Expense", "Income", "Friends / Personal Transfers", "Refund", "Internal", "Transfer",
                      "Internal  Transfer", "Internal Transfers", "InternalTransfer", None, 5, True, ""):
            with self.subTest(type=type_):
                self.assertIs(mark_internal_transfer(categorised(type=type_))["is_internal"], False)

    def test_type_none_from_review_is_not_internal(self):
        pending = categorised(merchant=None, type=None, category=None, subcategory=None, needs_review=True)
        self.assertFalse(mark_internal_transfer(pending)["is_internal"])

    def test_missing_type_key_is_not_internal(self):
        parsed_only = {"date": "2026-01-05", "description": "EXAMPLE", "amount": -100, "balance": 0}
        self.assertFalse(mark_internal_transfer(parsed_only)["is_internal"])

    def test_positive_amount_alone_is_not_internal(self):
        self.assertFalse(mark_internal_transfer(categorised(amount=500000, type="Income"))["is_internal"])
        self.assertFalse(mark_internal_transfer(categorised(amount=500000, type=None, needs_review=True))["is_internal"])
        self.assertFalse(mark_internal_transfer(categorised(amount=2500, type="Friends / Personal Transfers"))["is_internal"])

    def test_negative_amount_alone_is_not_internal(self):
        self.assertFalse(mark_internal_transfer(categorised(amount=-500000, type="Expense"))["is_internal"])
        self.assertFalse(mark_internal_transfer(categorised(amount=-500000, type=None, needs_review=True))["is_internal"])

    def test_transfer_wording_in_description_is_not_internal(self):
        for description in ("Transfer to xx0000 Example app", "Internal Transfer - Receipt 000000",
                            "Fast Transfer From SOMEONE", "Transfer To Own Savings"):
            with self.subTest(description=description):
                self.assertFalse(mark_internal_transfer(categorised(description=description, type="Expense"))["is_internal"])
                self.assertFalse(mark_internal_transfer(categorised(description=description, type=None))["is_internal"])

    def test_bank_name_in_description_is_not_internal(self):
        for description in ("EXAMPLE BANK TRANSFER", "To Orange Everyday xx0000", "Transfer to CommBank app",
                            "ING Savings Maximiser"):
            with self.subTest(description=description):
                self.assertFalse(mark_internal_transfer(categorised(description=description, type=None))["is_internal"])

    def test_original_not_mutated_and_fields_preserved(self):
        original = categorised(type="Internal Transfer", merchant="Own Savings")
        snapshot = copy.deepcopy(original)
        result = mark_internal_transfer(original)
        self.assertEqual(original, snapshot)
        self.assertNotIn("is_internal", original)
        self.assertIsNot(result, original)
        self.assertEqual({k: v for k, v in result.items() if k != "is_internal"}, snapshot)
        self.assertEqual(set(result), set(snapshot) | {"is_internal"})
        self.assertIs(type(result["amount"]), int)
        self.assertIs(type(result["balance"]), int)

    def test_is_internal_transfer_predicate(self):
        self.assertTrue(is_internal_transfer(categorised(type="Internal Transfer")))
        self.assertFalse(is_internal_transfer(categorised(type="Income")))


class BatchAndSplitTests(unittest.TestCase):
    def setUp(self):
        self.batch = [
            categorised(description="A", type="Expense"),
            categorised(description="B", type="Internal Transfer", merchant="Own Savings", amount=-5000),
            categorised(description="C", type="Income", amount=250000),
            categorised(description="D", type=None, merchant=None, category=None, needs_review=True),
            categorised(description="E", type="internal transfer", amount=5000),
            categorised(description="F", type="Friends / Personal Transfers", amount=2000),
        ]
        self.snapshot = copy.deepcopy(self.batch)

    def test_batch_preserves_order(self):
        results = mark_internal_transfers(self.batch)
        self.assertEqual([r["description"] for r in results], ["A", "B", "C", "D", "E", "F"])
        self.assertEqual([r["is_internal"] for r in results], [False, True, False, False, True, False])
        self.assertEqual(self.batch, self.snapshot)
        self.assertEqual(mark_internal_transfers([]), [])

    def test_split_separates_internal_from_normal(self):
        normal, internal = split_internal_transfers(self.batch)
        self.assertEqual([t["description"] for t in internal], ["B", "E"])
        self.assertTrue(all(t["is_internal"] is True for t in internal))
        self.assertEqual([t["description"] for t in normal], ["A", "C", "D", "F"])
        self.assertTrue(all(t["is_internal"] is False for t in normal))

    def test_split_loses_and_duplicates_nothing(self):
        normal, internal = split_internal_transfers(self.batch)
        self.assertEqual(len(normal) + len(internal), len(self.batch))
        combined = sorted(t["description"] for t in normal + internal)
        self.assertEqual(combined, sorted(t["description"] for t in self.batch))
        self.assertEqual(len(set(combined)), len(combined))
        stripped = [{k: v for k, v in t.items() if k != "is_internal"} for t in normal + internal]
        for original in self.batch:
            self.assertIn(original, stripped)
        self.assertEqual(self.batch, self.snapshot)  # inputs untouched, copies returned
        for marked in normal + internal:
            self.assertTrue(all(marked is not original for original in self.batch))

    def test_split_edge_cases(self):
        self.assertEqual(split_internal_transfers([]), ([], []))
        only_internal = [categorised(type="Internal Transfer")]
        normal, internal = split_internal_transfers(only_internal)
        self.assertEqual((len(normal), len(internal)), (0, 1))
        normal, internal = split_internal_transfers(t for t in self.batch)  # generator input
        self.assertEqual((len(normal), len(internal)), (4, 2))


if __name__ == "__main__":
    unittest.main()
