"""Step 14 tests for history_validation: integrity, totals, date coverage. Synthetic data only."""

import sqlite3
import tempfile
import unittest
from pathlib import Path

from database import init_db
from history_validation import (
    HistoryValidationError,
    validate_date_coverage,
    validate_history,
    validate_import_integrity,
    validate_storage_totals,
)


class HistoryTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.db_path = Path(self._tmp.name) / "test.db"
        init_db(self.db_path)
        self.conn = sqlite3.connect(self.db_path)
        self.addCleanup(self.conn.close)
        self._hash = 0

    def add_import(self, start, end, *, bank="ing", status="completed", parsed=10, approved=8,
                   file_hash=None, commit=True):
        self._hash += 1
        file_hash = file_hash if file_hash is not None else f"{self._hash:064x}"
        cur = self.conn.execute(
            "INSERT INTO imports (bank, original_filename, file_hash, statement_start_date, statement_end_date, "
            "status, parsed_count, approved_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (bank, "made-up.pdf", file_hash, start, end, status, parsed, approved),
        )
        if commit:
            self.conn.commit()
        return cur.lastrowid

    def add_transactions(self, n):
        for i in range(n):
            self._hash += 1
            self.conn.execute(
                "INSERT INTO transactions (bank, date, raw_description, amount, balance, transaction_hash) "
                "VALUES ('ing', '2026-01-01', 'SYNTHETIC', -1, 0, ?)", (f"{self._hash:064x}",))
        self.conn.commit()

    def snapshot(self):
        return {t: self.conn.execute(f"SELECT * FROM {t} ORDER BY rowid").fetchall()
                for t in ("imports", "transactions", "rules", "categories", "net_worth")}


class IntegrityTests(HistoryTestCase):
    def test_valid_completed_import_accepted(self):
        self.add_import("2026-01-01", "2026-01-31")
        self.add_import("2026-02-01", "2026-02-28", status="pending", parsed=-5)  # not completed: ignored
        result = validate_import_integrity(self.conn)
        self.assertEqual(result, {"completed_import_count": 1, "problems": [], "valid": True})

    def test_bad_records_reported_not_altered(self):
        cases = {
            "start_after_end": dict(start="2026-02-01", end="2026-01-31"),
            "missing_start": dict(start=None, end="2026-01-31"),
            "missing_end": dict(start="2026-01-01", end=None),
            "malformed_date": dict(start="2026-1-5", end="2026-01-31"),
            "parsed_negative": dict(start="2026-01-01", end="2026-01-31", parsed=-1, approved=0),
            "approved_negative": dict(start="2026-01-01", end="2026-01-31", parsed=5, approved=-1),
            "approved_exceeds_parsed": dict(start="2026-01-01", end="2026-01-31", parsed=5, approved=6),
            "malformed_hash": dict(start="2026-01-01", end="2026-01-31", file_hash="A" * 64),
            "unsupported_bank": dict(start="2026-01-01", end="2026-01-31", bank="westpac"),
        }
        ids = {name: self.add_import(**kwargs) for name, kwargs in cases.items()}
        before = self.snapshot()
        result = validate_import_integrity(self.db_path)
        self.assertFalse(result["valid"])
        self.assertEqual(result["completed_import_count"], len(cases))
        flagged = {p["import_id"]: p["problems"] for p in result["problems"]}
        self.assertEqual(set(flagged), set(ids.values()))
        self.assertTrue(any("after" in m for m in flagged[ids["start_after_end"]]))
        self.assertTrue(any("start" in m for m in flagged[ids["missing_start"]]))
        self.assertTrue(any("end" in m for m in flagged[ids["missing_end"]]))
        self.assertTrue(any("parsed_count" in m for m in flagged[ids["parsed_negative"]]))
        self.assertTrue(any("approved_count" in m for m in flagged[ids["approved_negative"]]))
        self.assertTrue(any("exceeds" in m for m in flagged[ids["approved_exceeds_parsed"]]))
        self.assertTrue(any("file_hash" in m for m in flagged[ids["malformed_hash"]]))
        self.assertTrue(any("bank" in m for m in flagged[ids["unsupported_bank"]]))
        self.assertEqual(self.snapshot(), before)


class IntegrityBoundaryTests(HistoryTestCase):
    def test_boundary_values_accepted(self):
        self.add_import("2026-01-15", "2026-01-15", parsed=0, approved=0)   # single day, zero counts
        self.add_import("2026-02-01", "2026-02-28", parsed=7, approved=7)   # approved == parsed
        self.add_import("2026-03-01", "2026-03-31", bank="CommBank")        # bank spelling normalised
        self.assertTrue(validate_import_integrity(self.conn)["valid"])

    def test_boundary_values_rejected(self):
        # SQLite INTEGER affinity turns 2.0/True into ints on insert; 2.5 and text survive as-is
        ids = [self.add_import("2026-01-01", "2026-01-31", file_hash="a" * 63),
               self.add_import("2026-02-01", "2026-02-28", file_hash="b" * 65),
               self.add_import("2026-03-01", "2026-03-31", file_hash="c" * 64 + "\n"),
               self.add_import("2026-04-01", "2026-04-30", parsed=2.5, approved=1),
               self.add_import("2026-05-01", "2026-05-31", parsed=2, approved="x"),
               self.add_import("2026-06-01\n", "2026-06-30")]
        flagged = {p["import_id"] for p in validate_import_integrity(self.conn)["problems"]}
        self.assertEqual(flagged, set(ids))


class TotalsTests(HistoryTestCase):
    def test_matching_totals(self):
        self.add_import("2026-01-01", "2026-01-31", approved=3)
        self.add_import("2026-02-01", "2026-02-28", approved=2)
        self.add_import("2026-03-01", "2026-03-31", approved=99, status="pending")  # not completed: excluded
        self.add_transactions(5)
        self.assertEqual(validate_storage_totals(self.conn), {
            "completed_import_count": 2, "sum_approved_count": 5, "stored_transaction_count": 5, "matches": True})

    def test_mismatch_reported_not_repaired(self):
        self.add_import("2026-01-01", "2026-01-31", approved=3)
        self.add_transactions(4)
        before = self.snapshot()
        result = validate_storage_totals(self.db_path)
        self.assertEqual((result["sum_approved_count"], result["stored_transaction_count"], result["matches"]),
                         (3, 4, False))
        self.assertEqual(self.snapshot(), before)

    def test_empty_database(self):
        self.assertEqual(validate_storage_totals(self.conn), {
            "completed_import_count": 0, "sum_approved_count": 0, "stored_transaction_count": 0, "matches": True})


class CoverageTests(HistoryTestCase):
    def test_single_statement_complete_self_coverage(self):
        a = self.add_import("2026-01-01", "2026-01-31", parsed=12, approved=9)
        result = validate_date_coverage(self.conn, [a])
        self.assertEqual((result["actual_start"], result["actual_end"], result["covered_days"], result["gap_days"]),
                         ("2026-01-01", "2026-01-31", 31, 0))
        self.assertEqual((result["gaps"], result["overlaps"], result["has_gaps"], result["has_overlaps"]),
                         ([], [], False, False))
        self.assertEqual((result["bank"], result["import_count"], result["statement_count"]), ("ing", 1, 1))
        self.assertEqual((result["parsed_transaction_count"], result["saved_transaction_count"]), (12, 9))
        self.assertEqual((result["expected_start"], result["expected_end"], result["expected_period_complete"]),
                         (None, None, None))
        self.assertEqual(result["periods"], [{"import_id": a, "start": "2026-01-01", "end": "2026-01-31"}])

    def test_adjacent_periods_have_no_gap(self):
        ids = [self.add_import("2026-01-01", "2026-01-31"), self.add_import("2026-02-01", "2026-02-28"),
               self.add_import("2026-03-01", "2026-03-31")]
        result = validate_date_coverage(self.conn, ids)
        self.assertEqual((result["gaps"], result["covered_days"], result["has_gaps"]), ([], 31 + 28 + 31, False))

    def test_one_day_gap(self):
        ids = [self.add_import("2026-01-01", "2026-01-31"), self.add_import("2026-02-02", "2026-02-28")]
        result = validate_date_coverage(self.conn, ids)
        self.assertEqual(result["gaps"], [{"start": "2026-02-01", "end": "2026-02-01"}])
        self.assertEqual((result["gap_days"], result["has_gaps"]), (1, True))

    def test_multi_day_gap_boundaries(self):
        ids = [self.add_import("2026-01-01", "2026-01-31"), self.add_import("2026-02-03", "2026-02-28"),
               self.add_import("2026-03-10", "2026-03-31")]
        result = validate_date_coverage(self.conn, ids)
        self.assertEqual(result["gaps"], [{"start": "2026-02-01", "end": "2026-02-02"},
                                          {"start": "2026-03-01", "end": "2026-03-09"}])
        self.assertEqual(result["gap_days"], 2 + 9)
        self.assertEqual(result["covered_days"], 31 + 26 + 22)

    def test_overlap_reported_without_gap(self):
        a = self.add_import("2026-01-01", "2026-03-31")
        b = self.add_import("2026-03-01", "2026-04-30")
        result = validate_date_coverage(self.conn, [b, a])
        self.assertEqual(result["overlaps"], [{"import_ids": [a, b], "start": "2026-03-01", "end": "2026-03-31"}])
        self.assertEqual((result["has_overlaps"], result["gaps"], result["has_gaps"]), (True, [], False))
        self.assertEqual(result["covered_days"], 31 + 28 + 31 + 30)  # March not counted twice
        self.assertEqual((result["actual_start"], result["actual_end"]), ("2026-01-01", "2026-04-30"))

    def test_nested_period(self):
        outer = self.add_import("2026-01-01", "2026-06-30")
        inner = self.add_import("2026-03-01", "2026-03-15")
        result = validate_date_coverage(self.conn, [inner, outer])
        self.assertEqual(result["overlaps"], [{"import_ids": [outer, inner], "start": "2026-03-01", "end": "2026-03-15"}])
        self.assertEqual((result["covered_days"], result["gaps"]), (31 + 28 + 31 + 30 + 31 + 30, []))

    def test_multiple_overlapping_periods_merge(self):
        a = self.add_import("2026-01-01", "2026-01-20")
        b = self.add_import("2026-01-10", "2026-02-10")
        c = self.add_import("2026-02-01", "2026-02-28")
        d = self.add_import("2026-04-01", "2026-04-30")
        result = validate_date_coverage(self.conn, [d, c, b, a])
        self.assertEqual(result["overlaps"], [
            {"import_ids": [a, b], "start": "2026-01-10", "end": "2026-01-20"},
            {"import_ids": [b, c], "start": "2026-02-01", "end": "2026-02-10"},
        ])
        self.assertEqual(result["covered_days"], 31 + 28 + 30)
        self.assertEqual(result["gaps"], [{"start": "2026-03-01", "end": "2026-03-31"}])
        self.assertEqual([p["import_id"] for p in result["periods"]], [a, b, c, d])  # sorted, not input order

    def test_sorted_by_period_not_by_id(self):
        feb = self.add_import("2026-02-01", "2026-02-28")   # inserted first -> lower id
        jan = self.add_import("2026-01-01", "2026-01-31")
        mar_overlap = self.add_import("2026-02-15", "2026-03-31")
        result = validate_date_coverage(self.conn, [feb, jan, mar_overlap])
        self.assertEqual([p["import_id"] for p in result["periods"]], [jan, feb, mar_overlap])
        self.assertEqual((result["actual_start"], result["actual_end"], result["covered_days"], result["gaps"]),
                         ("2026-01-01", "2026-03-31", 31 + 28 + 31, []))
        self.assertEqual(result["overlaps"], [{"import_ids": [feb, mar_overlap], "start": "2026-02-15",
                                               "end": "2026-02-28"}])

    def test_single_day_statement(self):
        a = self.add_import("2026-01-15", "2026-01-15", parsed=0, approved=0)
        result = validate_date_coverage(self.conn, [a])
        self.assertEqual((result["covered_days"], result["gaps"]), (1, []))

    def test_selected_totals(self):
        ids = [self.add_import("2026-01-01", "2026-01-31", parsed=100, approved=80),
               self.add_import("2026-02-01", "2026-02-28", parsed=50, approved=0)]
        self.add_import("2026-03-01", "2026-03-31", parsed=999, approved=999)  # not selected
        result = validate_date_coverage(self.conn, ids)
        self.assertEqual((result["statement_count"], result["parsed_transaction_count"],
                          result["saved_transaction_count"]), (2, 150, 80))


class InputSafetyTests(HistoryTestCase):
    def setUp(self):
        super().setUp()
        self.a = self.add_import("2026-01-01", "2026-01-31")

    def assert_raises(self, ids, **kwargs):
        before = self.snapshot()
        with self.assertRaises(HistoryValidationError):
            validate_date_coverage(self.conn, ids, **kwargs)
        self.assertEqual(self.snapshot(), before)

    def test_empty_and_malformed_ids(self):
        self.assert_raises([])
        self.assert_raises(["1"])
        self.assert_raises([True])
        self.assert_raises([self.a, self.a])

    def test_missing_id(self):
        self.assert_raises([self.a, 9999])

    def test_degenerate_ids(self):
        for bad in (None, 5, "12", [0], [-1], [2 ** 63], [1.0]):
            with self.subTest(bad=bad):
                self.assert_raises(bad)

    def test_large_id_lists_are_supported(self):
        ids = [self.add_import(f"2026-01-{d:02d}", f"2026-01-{d:02d}", commit=False) for d in range(1, 32)]
        self.conn.commit()
        ids = ids + [self.a]
        result = validate_date_coverage(self.conn, ids * 1)  # 32 real ids
        self.assertEqual((result["covered_days"], result["gaps"]), (31, []))
        self.assert_raises(ids + list(range(100000, 140000)))  # 40k ids: chunked query, unknown ids reported

    def test_corrupt_counts_rejected(self):
        bad = self.add_import("2026-02-01", "2026-02-28")
        self.conn.execute("UPDATE imports SET parsed_count = 'abc' WHERE id = ?", (bad,))
        self.conn.commit()
        self.assert_raises([bad])
        self.conn.execute("UPDATE imports SET parsed_count = 2, approved_count = 2.5 WHERE id = ?", (bad,))
        self.conn.commit()
        self.assert_raises([bad])

    def test_bank_spelling_variants_are_one_bank(self):
        variant = self.add_import("2026-02-01", "2026-02-28", bank=" ING ")
        result = validate_date_coverage(self.conn, [self.a, variant])
        self.assertEqual((result["bank"], result["gaps"]), ("ing", []))

    def test_non_completed_import_rejected(self):
        for status in ("pending", "validated", "failed"):
            with self.subTest(status=status):
                other = self.add_import("2026-02-01", "2026-02-28", status=status)
                self.assert_raises([self.a, other])

    def test_invalid_period_rejected(self):
        bad = self.add_import("2026-03-01", "2026-02-01")
        self.assert_raises([self.a, bad])
        missing = self.add_import(None, "2026-02-01")
        self.assert_raises([missing])

    def test_mixed_banks_rejected(self):
        cba = self.add_import("2026-02-01", "2026-02-28", bank="commbank")
        self.assert_raises([self.a, cba])
        self.assertEqual(validate_date_coverage(self.conn, [cba])["bank"], "commbank")

    def test_expected_range_input(self):
        self.assert_raises([self.a], expected_start="2026-01-01")
        self.assert_raises([self.a], expected_end="2026-01-31")
        self.assert_raises([self.a], expected_start="2026-02-01", expected_end="2026-01-01")
        for bad in ("2026-1-1", "01/01/2026", "2026-02-30", 20260101, ""):
            with self.subTest(bad=bad):
                self.assert_raises([self.a], expected_start=bad, expected_end="2026-01-31")


class ExpectedRangeTests(HistoryTestCase):
    def test_complete_expected_range(self):
        ids = [self.add_import("2026-01-01", "2026-01-31"), self.add_import("2026-02-01", "2026-02-28")]
        result = validate_date_coverage(self.conn, ids, expected_start="2026-01-01", expected_end="2026-02-28")
        self.assertEqual((result["expected_period_complete"], result["gaps"], result["gap_days"]), (True, [], 0))
        self.assertEqual((result["expected_start"], result["expected_end"]), ("2026-01-01", "2026-02-28"))

    def test_leading_and_trailing_gaps(self):
        ids = [self.add_import("2025-02-01", "2025-11-30")]
        result = validate_date_coverage(self.conn, ids, expected_start="2025-01-01", expected_end="2025-12-31")
        self.assertEqual(result["gaps"], [{"start": "2025-01-01", "end": "2025-01-31"},
                                          {"start": "2025-12-01", "end": "2025-12-31"}])
        self.assertEqual((result["expected_period_complete"], result["gap_days"]), (False, 62))
        self.assertEqual((result["actual_start"], result["actual_end"]), ("2025-02-01", "2025-11-30"))

    def test_internal_gap_within_expected_range(self):
        ids = [self.add_import("2026-01-01", "2026-01-31"), self.add_import("2026-03-01", "2026-03-31")]
        result = validate_date_coverage(self.conn, ids, expected_start="2026-01-01", expected_end="2026-03-31")
        self.assertEqual(result["gaps"], [{"start": "2026-02-01", "end": "2026-02-28"}])
        self.assertFalse(result["expected_period_complete"])

    def test_overlaps_with_full_coverage_still_complete(self):
        ids = [self.add_import("2026-01-01", "2026-03-31"), self.add_import("2026-03-01", "2026-04-30")]
        result = validate_date_coverage(self.conn, ids, expected_start="2026-01-01", expected_end="2026-04-30")
        self.assertTrue(result["expected_period_complete"])
        self.assertTrue(result["has_overlaps"])
        self.assertEqual(result["gaps"], [])

    def test_periods_beyond_expected_range_handled(self):
        ids = [self.add_import("2025-11-01", "2026-01-31"), self.add_import("2026-02-01", "2026-05-31")]
        result = validate_date_coverage(self.conn, ids, expected_start="2026-01-01", expected_end="2026-03-31")
        self.assertEqual((result["expected_period_complete"], result["gaps"], result["gap_days"]), (True, [], 0))
        self.assertEqual((result["actual_start"], result["actual_end"]), ("2025-11-01", "2026-05-31"))
        self.assertEqual(result["covered_days"], 30 + 31 + 31 + 28 + 31 + 30 + 31)  # all selected coverage
        # a window entirely outside the statements is a single full gap
        result = validate_date_coverage(self.conn, ids, expected_start="2027-01-01", expected_end="2027-01-10")
        self.assertEqual(result["gaps"], [{"start": "2027-01-01", "end": "2027-01-10"}])
        self.assertFalse(result["expected_period_complete"])


class ReadOnlyTests(HistoryTestCase):
    def test_all_validations_leave_every_table_unchanged(self):
        ids = [self.add_import("2026-01-01", "2026-01-31", approved=2), self.add_import("2026-02-05", "2026-02-28")]
        self.add_transactions(2)
        self.conn.execute("INSERT INTO categories (name) VALUES ('Synthetic')")
        self.conn.execute("INSERT INTO rules (pattern, category) VALUES ('SYNTHETIC', 'Synthetic')")
        self.conn.execute("INSERT INTO net_worth (snapshot_date, name, value) VALUES ('2026-01-01', 'x', 1)")
        self.conn.commit()
        before = self.snapshot()
        for db in (self.conn, self.db_path):
            validate_import_integrity(db)
            validate_storage_totals(db)
            validate_date_coverage(db, ids, expected_start="2026-01-01", expected_end="2026-03-31")
            validate_history(db, ids)
            validate_history(db)
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(self.conn.in_transaction)

    def test_caller_transaction_not_committed(self):
        a = self.add_import("2026-01-01", "2026-01-31", commit=False)
        self.assertTrue(self.conn.in_transaction)
        validate_date_coverage(self.conn, [a])
        validate_import_integrity(self.conn)
        validate_storage_totals(self.conn)
        self.assertTrue(self.conn.in_transaction)
        self.conn.rollback()
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM imports").fetchone()[0], 0)

    def test_path_and_missing_path(self):
        a = self.add_import("2026-01-01", "2026-01-31")
        self.assertEqual(validate_date_coverage(self.db_path, [a])["covered_days"], 31)
        with self.assertRaises(FileNotFoundError):
            validate_storage_totals(Path(self._tmp.name) / "missing.db")

    def test_wrapper_shape(self):
        a = self.add_import("2026-01-01", "2026-01-31", approved=0)
        result = validate_history(self.conn)
        self.assertEqual(set(result), {"integrity", "totals", "coverage"})
        self.assertIsNone(result["coverage"])
        self.assertEqual(validate_history(self.conn, [a])["coverage"]["import_count"], 1)


if __name__ == "__main__":
    unittest.main()
