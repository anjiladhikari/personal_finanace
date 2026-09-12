"""Step 13 tests for importer: two-phase historical import orchestration.

Synthetic statements are delivered by fake parsers routed through the real
pdf_intake table; the database is a throwaway init_db() file. No real PDFs.
"""

import copy
import hashlib
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pdf_intake
from database import init_db
from dedupe import transaction_hash
from importer import ImportDuplicateError, ImportValidationError, finalize_import, prepare_import
from review import approve_review_item, reject_review_item, update_review_item
from rules import RuleConflictError

PDF_BYTES = b"%PDF-1.4 synthetic statement bytes"


def statement(transactions, start="2026-01-01", end="2026-01-31"):
    opening = 10000
    running = opening
    rows = []
    for description, amount in transactions:
        running += amount
        rows.append({"date": "2026-01-05", "description": description, "amount": amount, "balance": running})
    return {"statement_start_date": start, "statement_end_date": end, "opening_balance": opening,
            "closing_balance": running, "transactions": rows}


# X, -X, X on one day: three legitimate transactions sharing every source field (occurrences 1, 1, 2)
COMMBANK_ROWS = [
    ("EXAMPLE CAFE MELBOURNE", -450),
    ("Transfer to xx0000 own savings", -5000),
    ("Transfer from xx0000 own savings", 5000),
    ("Transfer to xx0000 own savings", -5000),
    ("UNKNOWN SHOP 42", -1200),
]
ING_ROWS = [("Visa Purchase - Receipt 000000 EXAMPLE CAFE MELBOURNE", -450), ("SOMETHING NEW", 250)]


class ImporterTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)
        self.db_path = self.dir / "test.db"
        init_db(self.db_path)
        self.conn = sqlite3.connect(self.db_path)
        self.addCleanup(self.conn.close)
        self.conn.execute("INSERT INTO categories (name, active) VALUES ('Eating Out', 1)")
        self.conn.execute("INSERT INTO categories (name, active) VALUES ('Transfers', 1)")
        self.conn.execute("INSERT INTO rules (pattern, merchant, type, category, active) "
                          "VALUES ('EXAMPLE CAFE', 'Example Cafe', 'Expense', 'Eating Out', 1)")
        self.conn.execute("INSERT INTO rules (pattern, type, category, active) "
                          "VALUES ('own savings', 'Internal Transfer', 'Transfers', 1)")
        self.conn.commit()
        self.pdf = self.dir / "statement.pdf"
        self.pdf.write_bytes(PDF_BYTES)
        self.calls = []
        self.fake_parsers = {
            "commbank": lambda path: self.calls.append(("commbank", Path(path))) or statement(COMMBANK_ROWS),
            "ing": lambda path: self.calls.append(("ing", Path(path))) or statement(ING_ROWS, "2026-02-01", "2026-02-28"),
        }
        patcher = patch.dict(pdf_intake.PARSERS, self.fake_parsers)
        patcher.start()
        self.addCleanup(patcher.stop)

    def counts(self):
        return {t: self.conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                for t in ("transactions", "rules", "imports", "categories")}

    def prepared_commbank(self):
        return prepare_import(self.conn, self.pdf, "CommBank")

    def review_all(self, prepared, decide=approve_review_item):
        return [decide(item) for item in prepared["review_items"]]


class PrepareTests(ImporterTestCase):
    def test_prepare_computes_file_hash_and_metadata(self):
        prepared = self.prepared_commbank()
        self.assertEqual(prepared["file_hash"], hashlib.sha256(PDF_BYTES).hexdigest())
        self.assertEqual(prepared["bank"], "commbank")
        self.assertEqual(prepared["original_filename"], "statement.pdf")
        self.assertEqual((prepared["statement_start_date"], prepared["statement_end_date"]),
                         ("2026-01-01", "2026-01-31"))
        self.assertEqual(prepared["parsed_count"], 5)
        self.assertEqual(len(prepared["review_items"]), 5)

    def test_previously_imported_pdf_rejected_before_parsing(self):
        self.conn.execute("INSERT INTO imports (bank, original_filename, file_hash) VALUES (?, ?, ?)",
                          ("commbank", "old-name.pdf", hashlib.sha256(PDF_BYTES).hexdigest()))
        self.conn.commit()
        with self.assertRaises(ImportDuplicateError):
            self.prepared_commbank()
        self.assertEqual(self.calls, [])  # parser never invoked

    def test_correct_parser_routed_by_bank(self):
        self.prepared_commbank()
        prepare_import(self.conn, self.pdf, " ING ")
        self.assertEqual(self.calls, [("commbank", self.pdf), ("ing", self.pdf)])
        with self.assertRaises(pdf_intake.PDFIntakeError):
            prepare_import(self.conn, self.pdf, "westpac")

    def test_parser_output_flows_into_dedupe(self):
        self.conn.execute(
            "INSERT INTO transactions (bank, date, raw_description, amount, balance, transaction_hash) "
            "VALUES ('commbank', '2026-01-05', 'UNKNOWN SHOP 42', -1200, ?, ?)",
            (10000 - 450 - 5000 + 5000 - 5000 - 1200,
             transaction_hash("commbank", {"date": "2026-01-05", "description": "UNKNOWN SHOP 42",
                                           "amount": -1200, "balance": 10000 - 450 - 5000 + 5000 - 5000 - 1200})))
        self.conn.commit()
        items = self.prepared_commbank()["review_items"]
        self.assertEqual([i["occurrence"] for i in items], [1, 1, 1, 2, 1])
        self.assertEqual([i["is_duplicate"] for i in items], [False, False, False, False, True])
        self.assertEqual([i["in_database"] for i in items], [False, False, False, False, True])
        for item in items:
            self.assertEqual(item["transaction_hash"], transaction_hash("commbank", item, item["occurrence"]))

    def test_categorisation_and_internal_marking_applied(self):
        items = self.prepared_commbank()["review_items"]
        self.assertEqual((items[0]["merchant"], items[0]["type"], items[0]["category"], items[0]["needs_review"]),
                         ("Example Cafe", "Expense", "Eating Out", False))
        self.assertEqual([i["type"] for i in items[1:4]], ["Internal Transfer"] * 3)
        self.assertEqual([i["is_internal"] for i in items], [False, True, True, True, False])
        self.assertTrue(items[4]["needs_review"])
        self.assertIsNone(items[4]["category"])

    def test_review_items_have_review_state_and_source_fields(self):
        for item in self.prepared_commbank()["review_items"]:
            self.assertIsNone(item["decision"])
            self.assertIs(item["remember_choice"], False)
            self.assertEqual(item["bank"], "commbank")
            for field in ("date", "description", "amount", "balance", "transaction_hash", "occurrence",
                          "in_database", "in_batch", "is_duplicate", "is_internal", "needs_review"):
                self.assertIn(field, item)

    def test_preparation_writes_nothing_and_stores_no_pdf(self):
        before = self.counts()
        prepare_import(self.db_path, self.pdf, "commbank")
        self.assertEqual(self.counts(), before)
        self.assertEqual(sorted(p.name for p in self.dir.iterdir()), ["statement.pdf", "test.db"])
        self.assertEqual(self.pdf.read_bytes(), PDF_BYTES)


class CorrespondenceTests(ImporterTestCase):
    def setUp(self):
        super().setUp()
        self.prepared = self.prepared_commbank()

    def assert_rejected(self, reviewed):
        before = self.counts()
        with self.assertRaises(ImportValidationError):
            finalize_import(self.conn, self.prepared, reviewed)
        self.assertEqual(self.counts(), before)

    def test_item_count_must_match(self):
        reviewed = self.review_all(self.prepared)
        self.assert_rejected(reviewed[:-1])
        self.assert_rejected(reviewed + [reviewed[0]])

    def test_immutable_field_changes_rejected(self):
        for field, value in (("date", "2026-01-06"), ("description", "EXAMPLE CAFE MELBOURN"),
                             ("amount", -451), ("amount", -450.0), ("balance", 1), ("transaction_hash", "b" * 64),
                             ("occurrence", 2), ("is_duplicate", True), ("bank", "ing")):
            with self.subTest(field=field):
                reviewed = self.review_all(self.prepared)
                reviewed[0] = {**reviewed[0], field: value}
                self.assert_rejected(reviewed)

    def test_editable_fields_may_change(self):
        reviewed = self.review_all(self.prepared)
        reviewed[4] = update_review_item(self.conn, reviewed[4], merchant="Unknown Shop", type="Expense",
                                         category="Eating Out", subcategory="Lunch", remember_choice=True)
        reviewed[1] = reject_review_item(reviewed[1])
        summary = finalize_import(self.conn, self.prepared, reviewed)
        self.assertEqual(summary["status"], "completed")
        row = self.conn.execute("SELECT merchant, type, category, subcategory FROM transactions "
                                "WHERE raw_description = 'UNKNOWN SHOP 42'").fetchone()
        self.assertEqual(row, ("Unknown Shop", "Expense", "Eating Out", "Lunch"))

    def test_internal_status_recomputed_from_final_type(self):
        reviewed = self.review_all(self.prepared)
        # user says the first "own savings" row is really a payment to a friend; and the cafe is internal
        reviewed[1] = update_review_item(self.conn, reviewed[1], type="Friends / Personal Transfers")
        reviewed[0] = update_review_item(self.conn, reviewed[0], type="internal transfer")
        summary = finalize_import(self.conn, self.prepared, reviewed)
        stored = [r[0] for r in self.conn.execute("SELECT raw_description FROM transactions ORDER BY id")]
        self.assertIn("Transfer to xx0000 own savings", stored)   # stale is_internal=True was not trusted
        self.assertNotIn("EXAMPLE CAFE MELBOURNE", stored)         # stale is_internal=False was not trusted
        self.assertEqual((summary["saved_count"], summary["internal_count"]), (2, 3))


class FinalizeTests(ImporterTestCase):
    def setUp(self):
        super().setUp()
        self.prepared = self.prepared_commbank()
        self.snapshot = copy.deepcopy(self.prepared)

    def test_full_finalisation_outcomes_and_import_row(self):
        reviewed = self.review_all(self.prepared)
        reviewed[4] = reject_review_item(reviewed[4])
        reviewed_snapshot = copy.deepcopy(reviewed)
        summary = finalize_import(self.conn, self.prepared, reviewed)
        self.assertEqual(summary, {
            "status": "completed", "import_id": summary["import_id"], "parsed_count": 5, "saved_count": 1,
            "rejected_count": 1, "undecided_count": 0, "internal_count": 3, "duplicate_count": 0,
            "conflict_count": 0, "rules_created": 0, "rules_reactivated": 0, "rules_existing": 0,
        })
        self.assertEqual(self.counts()["transactions"], 1)
        row = self.conn.execute("SELECT bank, original_filename, file_hash, statement_start_date, "
                                "statement_end_date, status, parsed_count, approved_count FROM imports").fetchone()
        self.assertEqual(row, ("commbank", "statement.pdf", hashlib.sha256(PDF_BYTES).hexdigest(),
                               "2026-01-01", "2026-01-31", "completed", 5, 1))
        self.assertEqual(self.prepared, self.snapshot)  # inputs untouched
        self.assertEqual(reviewed, reviewed_snapshot)

    def test_connection_success_is_committed_and_visible_elsewhere(self):
        self.assertFalse(self.conn.in_transaction)
        finalize_import(self.conn, self.prepared, self.review_all(self.prepared))
        self.assertFalse(self.conn.in_transaction)
        other = sqlite3.connect(self.db_path)
        self.addCleanup(other.close)
        self.assertEqual(other.execute("SELECT COUNT(*) FROM imports").fetchone()[0], 1)
        self.assertEqual(other.execute("SELECT COUNT(*) FROM transactions").fetchone()[0], 2)

    def test_reviewed_items_without_bank_key_are_accepted(self):
        reviewed = [{k: v for k, v in item.items() if k != "bank"} for item in self.review_all(self.prepared)]
        summary = finalize_import(self.conn, self.prepared, reviewed)
        self.assertEqual(summary["saved_count"], 2)
        self.assertEqual({r[0] for r in self.conn.execute("SELECT bank FROM transactions")}, {"commbank"})

    def test_undecided_with_remember_choice_is_skipped_not_an_error(self):
        reviewed = self.review_all(self.prepared)
        reviewed[4] = update_review_item(self.conn, reviewed[4], type="Expense", category="Eating Out",
                                         remember_choice=True)
        reviewed[4] = {**reviewed[4], "decision": None}
        summary = finalize_import(self.conn, self.prepared, reviewed)
        self.assertEqual((summary["undecided_count"], summary["rules_created"]), (1, 0))
        self.assertEqual(self.counts()["rules"], 2)  # only the seeded rules

    def test_malformed_review_state_rejected_before_writing(self):
        for broken in ({"decision": "maybe"}, {"remember_choice": 1}, {"remember_choice": None}):
            with self.subTest(broken=broken):
                reviewed = self.review_all(self.prepared)
                reviewed[0] = {**reviewed[0], **broken}
                before = self.counts()
                with self.assertRaises(ImportValidationError):
                    finalize_import(self.conn, self.prepared, reviewed)
                self.assertEqual(self.counts(), before)
        reviewed = self.review_all(self.prepared)
        del reviewed[0]["remember_choice"]
        with self.assertRaises(ImportValidationError):
            finalize_import(self.conn, self.prepared, reviewed)

    def test_undecided_and_duplicates_not_saved_and_not_counted(self):
        # a stored copy of the cafe row makes it a duplicate at preparation time
        cafe = self.prepared["review_items"][0]
        self.conn.execute("INSERT INTO transactions (bank, date, raw_description, amount, balance, transaction_hash) "
                          "VALUES (?, ?, ?, ?, ?, ?)", ("commbank", cafe["date"], cafe["description"], cafe["amount"],
                                                        cafe["balance"], cafe["transaction_hash"]))
        self.conn.commit()
        prepared = self.prepared_commbank()
        reviewed = self.review_all(prepared)
        reviewed[4] = {**reviewed[4], "decision": None}
        summary = finalize_import(self.conn, prepared, reviewed)
        self.assertEqual((summary["saved_count"], summary["duplicate_count"], summary["undecided_count"],
                          summary["internal_count"]), (0, 1, 1, 3))
        self.assertEqual(self.counts()["transactions"], 1)  # only the pre-existing row
        self.assertEqual(self.conn.execute("SELECT approved_count FROM imports").fetchone()[0], 0)

    def test_remember_choice_creates_rules_including_internal_and_not_rejected(self):
        reviewed = self.review_all(self.prepared)
        reviewed[4] = update_review_item(self.conn, reviewed[4], type="Expense", category="Eating Out",
                                         remember_choice=True)
        reviewed[2] = update_review_item(self.conn, reviewed[2], remember_choice=True)  # approved internal
        reviewed[0] = update_review_item(self.conn, reviewed[0], remember_choice=True)  # identical to existing? no: pattern is full description
        reviewed[3] = reject_review_item(update_review_item(self.conn, reviewed[3], remember_choice=True))
        summary = finalize_import(self.conn, self.prepared, reviewed)
        patterns = [r[0] for r in self.conn.execute("SELECT pattern FROM rules ORDER BY id")]
        self.assertIn("UNKNOWN SHOP 42", patterns)
        self.assertIn("Transfer from xx0000 own savings", patterns)
        self.assertIn("EXAMPLE CAFE MELBOURNE", patterns)
        self.assertNotIn("Transfer to xx0000 own savings", patterns)  # rejected never remembers
        self.assertEqual(summary["rules_created"], 3)
        self.assertEqual(self.conn.execute("SELECT type FROM rules WHERE pattern = ?",
                                           ("Transfer from xx0000 own savings",)).fetchone()[0], "Internal Transfer")

    def test_second_finalisation_of_same_file_rejected(self):
        finalize_import(self.conn, self.prepared, self.review_all(self.prepared))
        with self.assertRaises(ImportDuplicateError):
            finalize_import(self.conn, self.prepared, self.review_all(self.prepared))
        self.assertEqual(self.counts()["imports"], 1)

    def test_file_unique_race_rolls_back_without_overwriting(self):
        self.conn.execute("INSERT INTO imports (bank, original_filename, file_hash, status, approved_count) "
                          "VALUES ('commbank', 'first.pdf', ?, 'completed', 99)", (self.prepared["file_hash"],))
        self.conn.commit()
        with patch("importer.is_file_duplicate", return_value=False):  # bypass the pre-check to hit UNIQUE
            with self.assertRaises(ImportDuplicateError):
                finalize_import(self.conn, self.prepared, self.review_all(self.prepared))
        self.assertEqual(self.counts()["transactions"], 0)  # saves rolled back
        self.assertEqual(self.conn.execute("SELECT original_filename, approved_count FROM imports").fetchall(),
                         [("first.pdf", 99)])

    def test_transaction_unique_conflict_handled_safely(self):
        cafe = self.prepared["review_items"][0]
        self.conn.execute("INSERT INTO transactions (bank, date, raw_description, amount, balance, transaction_hash) "
                          "VALUES ('commbank', ?, 'ORIGINAL ROW', 1, 1, ?)", (cafe["date"], cafe["transaction_hash"]))
        self.conn.commit()
        summary = finalize_import(self.conn, self.prepared, self.review_all(self.prepared))  # prepared says not duplicate
        self.assertEqual((summary["conflict_count"], summary["saved_count"]), (1, 1))
        self.assertEqual(self.conn.execute("SELECT raw_description FROM transactions WHERE transaction_hash = ?",
                                           (cafe["transaction_hash"],)).fetchone()[0], "ORIGINAL ROW")
        self.assertEqual(self.conn.execute("SELECT approved_count FROM imports").fetchone()[0], 1)

    def test_rule_conflict_rolls_everything_back(self):
        self.conn.execute("INSERT INTO rules (pattern, merchant, type, category) "
                          "VALUES ('UNKNOWN SHOP 42', 'Someone Else', 'Expense', 'Eating Out')")
        self.conn.commit()
        before = self.counts()
        reviewed = self.review_all(self.prepared)
        reviewed[4] = update_review_item(self.conn, reviewed[4], merchant="Unknown Shop", type="Expense",
                                         category="Eating Out", remember_choice=True)
        with self.assertRaises(RuleConflictError):
            finalize_import(self.conn, self.prepared, reviewed)
        self.assertEqual(self.counts(), before)
        self.assertFalse(self.conn.in_transaction)


class RollbackTests(ImporterTestCase):
    def setUp(self):
        super().setUp()
        self.conn.execute("INSERT INTO transactions (bank, date, raw_description, amount, balance, transaction_hash) "
                          "VALUES ('ing', '2025-12-01', 'PRE-EXISTING', -1, 1, ?)", ("f" * 64,))
        self.conn.execute("INSERT INTO imports (bank, original_filename, file_hash, status) "
                          "VALUES ('ing', 'earlier.pdf', 'e' * 64, 'completed')")
        self.conn.commit()
        self.before = {t: self.conn.execute(f"SELECT * FROM {t} ORDER BY id").fetchall()
                       for t in ("transactions", "rules", "imports", "categories")}
        self.prepared = self.prepared_commbank()
        self.reviewed = self.review_all(self.prepared)
        self.reviewed[4] = update_review_item(self.conn, self.reviewed[4], type="Expense", category="Eating Out",
                                              remember_choice=True)

    def assert_nothing_changed(self):
        for table, rows in self.before.items():
            self.assertEqual(self.conn.execute(f"SELECT * FROM {table} ORDER BY id").fetchall(), rows, table)
        self.assertFalse(self.conn.in_transaction)

    def trigger(self, table, condition):
        self.conn.execute(f"CREATE TRIGGER boom BEFORE INSERT ON {table} WHEN {condition} "
                          "BEGIN SELECT RAISE(ABORT, 'boom'); END")
        self.conn.commit()

    def test_error_during_transaction_save_rolls_back(self):
        self.trigger("transactions", "NEW.raw_description = 'UNKNOWN SHOP 42'")
        with self.assertRaises(sqlite3.IntegrityError):
            finalize_import(self.conn, self.prepared, self.reviewed)
        self.assert_nothing_changed()

    def test_error_during_rule_creation_rolls_back(self):
        self.trigger("rules", "NEW.pattern = 'UNKNOWN SHOP 42'")
        with self.assertRaises(sqlite3.IntegrityError):
            finalize_import(self.conn, self.prepared, self.reviewed)
        self.assert_nothing_changed()

    def test_error_during_import_write_rolls_back(self):
        self.trigger("imports", "NEW.original_filename = 'statement.pdf'")
        with self.assertRaises(sqlite3.IntegrityError):
            finalize_import(self.conn, self.prepared, self.reviewed)
        self.assert_nothing_changed()

    def test_successful_finalisation_after_failure_and_path_access(self):
        self.trigger("imports", "NEW.original_filename = 'never.pdf'")  # inert trigger
        summary = finalize_import(self.db_path, self.prepared, self.reviewed)
        self.assertEqual((summary["saved_count"], summary["rules_created"]), (2, 1))
        self.assertEqual(self.counts(), {"transactions": 3, "rules": 3, "imports": 2, "categories": 2})


if __name__ == "__main__":
    unittest.main()
