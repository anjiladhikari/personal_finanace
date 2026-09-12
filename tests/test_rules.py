"""Step 12 tests for rules: remember-choice rule creation and management. Synthetic data only."""

import copy
import sqlite3
import tempfile
import unittest
from pathlib import Path

from database import init_db
from rules import (
    RuleConflictError,
    RuleValidationError,
    activate_rule,
    deactivate_rule,
    list_rules,
    remember_review_choice,
)

DESCRIPTION = "  Example Cafe  MELBOURNE xx0000 "


def reviewed(**overrides):
    """A made-up approved review item asking to be remembered."""
    base = {
        "bank": "ing", "date": "2026-01-05", "description": DESCRIPTION, "amount": -450, "balance": 1000,
        "merchant": "Example Cafe", "type": "Expense", "category": "Eating Out", "subcategory": "Coffee",
        "needs_review": True, "is_internal": False, "is_duplicate": False,
        "transaction_hash": "a" * 64, "occurrence": 1,
        "remember_choice": True, "decision": "approved",
    }
    base.update(overrides)
    return base


class RulesTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.db_path = Path(self._tmp.name) / "test.db"
        init_db(self.db_path)
        self.conn = sqlite3.connect(self.db_path)
        self.addCleanup(self.conn.close)
        self.conn.execute("INSERT INTO categories (name, active) VALUES ('Eating Out', 1)")
        self.conn.execute("INSERT INTO categories (name, active) VALUES ('Transfers', 1)")
        self.conn.execute("INSERT INTO categories (name, active) VALUES ('Retired', 0)")
        self.conn.commit()

    def raw_rules(self):
        return self.conn.execute(
            "SELECT pattern, merchant, type, category, subcategory, active FROM rules ORDER BY id"
        ).fetchall()

    def other_counts(self):
        return tuple(self.conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                     for t in ("transactions", "imports", "net_worth", "categories"))


class CreationTests(RulesTestCase):
    def test_approved_and_remembered_creates_active_rule_with_exact_fields(self):
        result = remember_review_choice(self.conn, reviewed())
        self.assertEqual(result["status"], "created")
        self.assertEqual(self.raw_rules(), [(DESCRIPTION, "Example Cafe", "Expense", "Eating Out", "Coffee", 1)])
        rule = result["rule"]
        self.assertEqual((rule["pattern"], rule["merchant"], rule["type"], rule["category"],
                          rule["subcategory"], rule["active"]),
                         (DESCRIPTION, "Example Cafe", "Expense", "Eating Out", "Coffee", True))

    def test_pattern_is_raw_description_verbatim(self):
        odd = "  card XX1234 example  cafe   value date: 01/01/2026 "
        remember_review_choice(self.conn, reviewed(description=odd))
        self.assertEqual(self.raw_rules()[0][0], odd)  # not trimmed, not upper-cased, not cleaned

    def test_remember_false_creates_nothing(self):
        result = remember_review_choice(self.conn, reviewed(remember_choice=False))
        self.assertEqual(result, {"status": "not_requested", "rule": None})
        self.assertEqual(self.raw_rules(), [])

    def test_rejected_or_undecided_never_create_rules(self):
        for decision in ("rejected", None):
            with self.subTest(decision=decision), self.assertRaises(RuleValidationError):
                remember_review_choice(self.conn, reviewed(decision=decision))
        self.assertEqual(self.raw_rules(), [])

    def test_empty_or_invalid_description_rejected(self):
        for description in ("", "   ", "\n\t", None, 5):
            with self.subTest(description=description), self.assertRaises(RuleValidationError):
                remember_review_choice(self.conn, reviewed(description=description))
        self.assertEqual(self.raw_rules(), [])

    def test_optional_fields_may_be_none(self):
        remember_review_choice(self.conn, reviewed(merchant=None, type=None, subcategory=None))
        self.assertEqual(self.raw_rules(), [(DESCRIPTION, None, None, "Eating Out", None, 1)])

    def test_category_required_by_schema(self):
        with self.assertRaises(RuleValidationError):
            remember_review_choice(self.conn, reviewed(category=None))
        self.assertEqual(self.raw_rules(), [])

    def test_category_must_exist_and_be_active(self):
        for category in ("Retired", "No Such Category", "eating out"):
            with self.subTest(category=category), self.assertRaises(RuleValidationError):
                remember_review_choice(self.conn, reviewed(category=category))
        self.assertEqual(self.raw_rules(), [])
        self.assertEqual(self.other_counts()[3], 3)  # no category created

    def test_invalid_field_types_and_remember_choice_rejected(self):
        for overrides in ({"merchant": 5}, {"type": ["Expense"]}, {"subcategory": b"x"}, {"category": 1},
                          {"remember_choice": 1}, {"remember_choice": "yes"}, {"remember_choice": None}):
            with self.subTest(overrides=overrides), self.assertRaises(RuleValidationError):
                remember_review_choice(self.conn, reviewed(**overrides))
        self.assertEqual(self.raw_rules(), [])

    def test_internal_transfer_and_friends_types_stored_exactly(self):
        remember_review_choice(self.conn, reviewed(description="OWN SAVINGS xx1", type="Internal Transfer",
                                                    category="Transfers", merchant=None, subcategory=None,
                                                    amount=-5000))
        remember_review_choice(self.conn, reviewed(description="FRIEND REPAY xx2", type="Friends / Personal Transfers",
                                                    category="Transfers", merchant="A Friend", subcategory=None,
                                                    amount=2500))
        self.assertEqual([r[2] for r in self.raw_rules()], ["Internal Transfer", "Friends / Personal Transfers"])

    def test_review_item_not_mutated_and_no_transaction_saved(self):
        item = reviewed()
        snapshot = copy.deepcopy(item)
        before = self.other_counts()
        remember_review_choice(self.conn, item)
        self.assertEqual(item, snapshot)
        self.assertEqual(self.other_counts(), before)


class DuplicateTests(RulesTestCase):
    def setUp(self):
        super().setUp()
        self.first = remember_review_choice(self.conn, reviewed())["rule"]

    def test_identical_active_rule_not_duplicated(self):
        result = remember_review_choice(self.conn, reviewed())
        self.assertEqual(result["status"], "already_exists")
        self.assertEqual(result["rule"]["id"], self.first["id"])
        self.assertEqual(len(self.raw_rules()), 1)

    def test_case_insensitive_pattern_duplicate_detection(self):
        result = remember_review_choice(self.conn, reviewed(description=DESCRIPTION.upper()))
        self.assertEqual(result["status"], "already_exists")
        self.assertEqual(self.raw_rules()[0][0], DESCRIPTION)  # original spelling kept
        self.assertEqual(len(self.raw_rules()), 1)

    def test_identical_inactive_rule_is_reactivated(self):
        deactivate_rule(self.conn, DESCRIPTION)
        result = remember_review_choice(self.conn, reviewed(description=DESCRIPTION.lower()))
        self.assertEqual(result["status"], "reactivated")
        self.assertEqual(self.raw_rules(), [(DESCRIPTION, "Example Cafe", "Expense", "Eating Out", "Coffee", 1)])

    def test_same_pattern_different_fields_conflict(self):
        for overrides in ({"merchant": "Other Cafe"}, {"merchant": None}, {"type": "Income"}, {"type": None},
                          {"category": "Transfers"}, {"subcategory": "Lunch"}, {"subcategory": None}):
            with self.subTest(overrides=overrides), self.assertRaises(RuleConflictError):
                remember_review_choice(self.conn, reviewed(**overrides))
        self.assertEqual(self.raw_rules(), [(DESCRIPTION, "Example Cafe", "Expense", "Eating Out", "Coffee", 1)])

    def test_conflict_also_when_existing_rule_is_inactive(self):
        deactivate_rule(self.conn, DESCRIPTION)
        with self.assertRaises(RuleConflictError):
            remember_review_choice(self.conn, reviewed(merchant="Other Cafe"))
        self.assertEqual(self.raw_rules()[0][5], 0)  # still inactive, not overwritten

    def test_ambiguous_existing_rules_conflict(self):
        self.conn.execute("INSERT INTO rules (pattern, category) VALUES (?, 'Eating Out')", (DESCRIPTION.upper(),))
        self.conn.commit()
        with self.assertRaises(RuleConflictError):
            remember_review_choice(self.conn, reviewed())
        with self.assertRaises(RuleConflictError):
            deactivate_rule(self.conn, DESCRIPTION)
        with self.assertRaises(RuleConflictError):
            activate_rule(self.conn, DESCRIPTION)


class ManagementTests(RulesTestCase):
    def setUp(self):
        super().setUp()
        remember_review_choice(self.conn, reviewed(description="beta cafe"))
        remember_review_choice(self.conn, reviewed(description="Alpha Shop", merchant="Alpha"))
        remember_review_choice(self.conn, reviewed(description="gamma", merchant="Gamma"))
        remember_review_choice(self.conn, reviewed(description="apple", merchant="Apple"))
        remember_review_choice(self.conn, reviewed(description="Zed Store", merchant="Zed"))
        deactivate_rule(self.conn, "GAMMA")

    def test_list_active_only_by_default_in_case_insensitive_order(self):
        # binary ordering would put "Alpha Shop" and "Zed Store" before every lowercase pattern
        self.assertEqual([r["pattern"] for r in list_rules(self.conn)],
                         ["Alpha Shop", "apple", "beta cafe", "Zed Store"])
        self.assertEqual(set(list_rules(self.conn)[0]),
                         {"id", "pattern", "merchant", "type", "category", "subcategory", "active", "created_at"})

    def test_include_inactive(self):
        records = list_rules(self.conn, include_inactive=True)
        self.assertEqual([(r["pattern"], r["active"]) for r in records],
                         [("Alpha Shop", True), ("apple", True), ("beta cafe", True), ("gamma", False),
                          ("Zed Store", True)])

    def test_deactivate_and_activate(self):
        record = deactivate_rule(self.conn, "alpha SHOP")  # case-insensitive lookup, stored spelling kept
        self.assertEqual((record["pattern"], record["active"]), ("Alpha Shop", False))
        self.assertEqual([r["pattern"] for r in list_rules(self.conn)], ["apple", "beta cafe", "Zed Store"])
        self.assertEqual(deactivate_rule(self.conn, "ALPHA SHOP")["active"], False)  # idempotent
        with self.assertRaises(RuleValidationError):
            deactivate_rule(self.conn, "  alpha shop")  # whitespace is part of a pattern, never trimmed
        record = activate_rule(self.conn, "alpha shop")
        self.assertEqual((record["pattern"], record["active"]), ("Alpha Shop", True))
        self.assertEqual(activate_rule(self.conn, "Alpha Shop")["active"], True)  # idempotent
        self.assertEqual(len(self.raw_rules()), 5)  # nothing deleted

    def test_missing_rule_operations_raise(self):
        for pattern in ("no such pattern", "", "   ", None):
            with self.subTest(pattern=pattern), self.assertRaises(RuleValidationError):
                deactivate_rule(self.conn, pattern)
            with self.subTest(pattern=pattern), self.assertRaises(RuleValidationError):
                activate_rule(self.conn, pattern)
        self.assertEqual(len(self.raw_rules()), 5)


class DatabaseBehaviourTests(RulesTestCase):
    def test_other_tables_untouched(self):
        before = self.other_counts()
        remember_review_choice(self.conn, reviewed())
        deactivate_rule(self.conn, DESCRIPTION)
        activate_rule(self.conn, DESCRIPTION)
        list_rules(self.conn, include_inactive=True)
        self.assertEqual(self.other_counts(), before)

    def test_sql_values_are_parameterised(self):
        awkward = "O'Brien's \"Cafe\"; DROP TABLE rules; -- 50% off_"
        remember_review_choice(self.conn, reviewed(description=awkward, merchant=awkward, subcategory=awkward))
        self.assertEqual(self.raw_rules(), [(awkward, awkward, "Expense", "Eating Out", awkward, 1)])
        self.assertEqual(deactivate_rule(self.conn, awkward)["active"], False)
        with self.assertRaises(RuleValidationError):
            activate_rule(self.conn, "x' OR 1=1 --")

    def test_path_and_connection_both_commit(self):
        remember_review_choice(self.db_path, reviewed())
        remember_review_choice(self.conn, reviewed(description="second"))
        other = sqlite3.connect(self.db_path)
        self.addCleanup(other.close)
        self.assertEqual(other.execute("SELECT COUNT(*) FROM rules").fetchone()[0], 2)
        self.assertEqual(deactivate_rule(self.db_path, "SECOND")["active"], False)
        self.assertEqual([r["pattern"] for r in list_rules(self.db_path)], [DESCRIPTION])

    def test_database_error_rolls_back_and_propagates(self):
        self.conn.execute(
            "CREATE TRIGGER boom BEFORE INSERT ON rules WHEN NEW.pattern = 'BOOM' "
            "BEGIN SELECT RAISE(ABORT, 'boom'); END"
        )
        self.conn.commit()
        with self.assertRaises(sqlite3.IntegrityError):
            remember_review_choice(self.conn, reviewed(description="BOOM"))
        self.assertEqual(self.raw_rules(), [])
        self.assertFalse(self.conn.in_transaction)
        self.assertEqual(remember_review_choice(self.conn, reviewed())["status"], "created")  # still usable

    def test_caller_transaction_not_committed(self):
        self.conn.execute("INSERT INTO imports (bank, original_filename, file_hash) VALUES ('ing', 'x.pdf', 'h')")
        self.assertTrue(self.conn.in_transaction)
        remember_review_choice(self.conn, reviewed())
        deactivate_rule(self.conn, DESCRIPTION)
        self.assertTrue(self.conn.in_transaction)
        self.conn.rollback()
        self.assertEqual(self.raw_rules(), [])
        self.assertEqual(self.other_counts()[1], 0)


class IntegrationTests(RulesTestCase):
    def test_remembered_rule_drives_future_categorisation(self):
        from categories import add_category
        from categorizer import categorize_transaction
        from review import approve_review_item, create_review_item, update_review_item

        add_category(self.conn, "Coffee")
        item = create_review_item({"date": "2026-01-05", "description": "EXAMPLE CAFE MELBOURNE", "amount": -450,
                                   "balance": 1000, "merchant": None, "type": None, "category": None,
                                   "subcategory": None, "needs_review": True, "is_internal": False,
                                   "is_duplicate": False, "transaction_hash": "b" * 64})
        item = update_review_item(self.conn, item, merchant="Example Cafe", type="Expense", category="Coffee",
                                  subcategory="Flat white", remember_choice=True)
        self.assertEqual(remember_review_choice(self.conn, approve_review_item(item))["status"], "created")

        later = {"date": "2026-02-01", "description": "Card xx9999 example cafe melbourne Value Date: 30/01/2026",
                 "amount": -500, "balance": 500}
        result = categorize_transaction(self.conn, later)
        self.assertEqual((result["merchant"], result["type"], result["category"], result["subcategory"],
                          result["needs_review"]),
                         ("Example Cafe", "Expense", "Coffee", "Flat white", False))
        self.assertEqual(result["description"], later["description"])

        deactivate_rule(self.conn, "example cafe melbourne")
        again = categorize_transaction(self.conn, later)
        self.assertTrue(again["needs_review"])
        self.assertIsNone(again["category"])


if __name__ == "__main__":
    unittest.main()
