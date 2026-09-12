"""Step 5 tests for pdf_intake: input validation and parser routing.

Uses throwaway files and fake parsers only. Real PDF parsing is covered by
the frozen parsers' own tests and the Step 4 regression suite.
"""

import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pdf_intake
from commbank_parser import CommBankParseError, CommBankValidationError
from ing_parser import INGParseError, INGValidationError
from pdf_intake import PDFIntakeError, normalize_bank, process_pdf


def fake_result(tag):
    """A parser-shaped result with made-up integer cents."""
    return {
        "statement_start_date": "2026-01-01",
        "statement_end_date": "2026-01-31",
        "opening_balance": 1578,
        "closing_balance": 378,
        "transactions": [
            {"date": "2026-01-05", "description": f"{tag} purchase", "amount": -1200, "balance": 378},
        ],
    }


class FakeParser:
    """Records calls; returns a fixed result or raises."""

    def __init__(self, result=None, error=None):
        self.result = result
        self.error = error
        self.calls = []

    def __call__(self, path):
        self.calls.append(Path(path))
        if self.error is not None:
            raise self.error
        return self.result


class IntakeTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.pdf = self.dir / "statement.pdf"
        self.pdf.write_bytes(b"%PDF-1.4 not a real statement")
        self.addCleanup(self._tmp.cleanup)
        self.commbank = FakeParser(result=fake_result("commbank"))
        self.ing = FakeParser(result=fake_result("ing"))
        patcher = patch.dict(pdf_intake.PARSERS, {"commbank": self.commbank, "ing": self.ing})
        patcher.start()
        self.addCleanup(patcher.stop)

    def assert_nothing_written(self):
        """Intake must not copy, rename or dump anything next to the upload."""
        self.assertEqual([p.name for p in self.dir.iterdir()], ["statement.pdf"])

    def assert_no_parser_called(self):
        self.assertEqual(self.commbank.calls, [])
        self.assertEqual(self.ing.calls, [])


class BankValidationTests(IntakeTestCase):
    def test_unsupported_bank_is_rejected(self):
        for bank in (
            "westpac", "cba", "commonwealth", "commonwealth bank", "comm bank",
            "ing bank", "ing direct", "ingdirect", "", "  ", None, 3,
        ):
            with self.subTest(bank=bank), self.assertRaises(PDFIntakeError):
                process_pdf(self.pdf, bank)
        self.assert_no_parser_called()

    def test_bank_value_normalization(self):
        self.assertEqual(normalize_bank("commbank"), "commbank")
        self.assertEqual(normalize_bank("CommBank"), "commbank")
        self.assertEqual(normalize_bank("COMMBANK"), "commbank")
        self.assertEqual(normalize_bank("ing"), "ing")
        self.assertEqual(normalize_bank("ING"), "ing")
        self.assertEqual(normalize_bank("  Ing "), "ing")

    def test_normalized_bank_routes_correctly(self):
        process_pdf(self.pdf, "COMMBANK")
        process_pdf(self.pdf, " Ing ")
        self.assertEqual(len(self.commbank.calls), 1)
        self.assertEqual(len(self.ing.calls), 1)


class FileValidationTests(IntakeTestCase):
    def test_missing_file_is_rejected(self):
        with self.assertRaises(PDFIntakeError):
            process_pdf(self.dir / "nope.pdf", "commbank")
        self.assert_no_parser_called()

    def test_directory_is_rejected(self):
        folder = self.dir / "folder.pdf"
        folder.mkdir()
        with self.assertRaises(PDFIntakeError):
            process_pdf(folder, "ing")
        self.assert_no_parser_called()

    def test_non_pdf_extension_is_rejected(self):
        other = self.dir / "statement.txt"
        other.write_bytes(b"%PDF-1.4 looks like a pdf but is not named one")
        with self.assertRaises(PDFIntakeError):
            process_pdf(other, "commbank")
        self.assert_no_parser_called()

    def test_empty_pdf_is_rejected(self):
        empty = self.dir / "empty.pdf"
        empty.write_bytes(b"")
        with self.assertRaises(PDFIntakeError):
            process_pdf(empty, "ing")
        self.assert_no_parser_called()

    def test_uppercase_extension_is_accepted(self):
        upper = self.dir / "STATEMENT.PDF"
        upper.write_bytes(b"%PDF-1.4 x")
        process_pdf(upper, "commbank")
        self.assertEqual(self.commbank.calls, [upper])


class RoutingTests(IntakeTestCase):
    def test_commbank_selection_calls_commbank_parser(self):
        process_pdf(self.pdf, "commbank")
        self.assertEqual(self.commbank.calls, [self.pdf])
        self.assertEqual(self.ing.calls, [])

    def test_ing_selection_calls_ing_parser(self):
        process_pdf(str(self.pdf), "ing")
        self.assertEqual(self.ing.calls, [self.pdf])
        self.assertEqual(self.commbank.calls, [])

    def test_parser_result_is_returned_unchanged(self):
        for bank, fake in (("commbank", self.commbank), ("ing", self.ing)):
            with self.subTest(bank=bank):
                snapshot = copy.deepcopy(fake.result)
                result = process_pdf(self.pdf, bank)
                self.assertIs(result, fake.result)   # same object, not a copy
                self.assertEqual(result, snapshot)   # no fields added, no money touched
                self.assert_nothing_written()

    def test_parser_errors_are_not_swallowed(self):
        cases = (
            ("commbank", self.commbank, CommBankParseError),
            ("commbank", self.commbank, CommBankValidationError),
            ("ing", self.ing, INGParseError),
            ("ing", self.ing, INGValidationError),
        )
        for bank, fake, error_class in cases:
            with self.subTest(error=error_class.__name__):
                fake.error = error_class(f"{error_class.__name__} detail")
                with self.assertRaises(error_class) as ctx:
                    process_pdf(self.pdf, bank)
                self.assertIs(type(ctx.exception), error_class)
                self.assertEqual(str(ctx.exception), f"{error_class.__name__} detail")

    def test_wrong_bank_is_not_retried_with_other_parser(self):
        self.commbank.error = CommBankParseError("not a CommBank statement")
        with self.assertRaises(CommBankParseError):
            process_pdf(self.pdf, "commbank")
        self.assertEqual(self.ing.calls, [])


class RealParserWiringTests(unittest.TestCase):
    """Without mocks, the routing table points at the frozen parsers."""

    def test_routing_table_targets_frozen_parsers(self):
        import commbank_parser
        import ing_parser
        self.assertEqual(set(pdf_intake.PARSERS), {"commbank", "ing"})
        self.assertIs(pdf_intake.PARSERS["commbank"], commbank_parser.parse_commbank_pdf)
        self.assertIs(pdf_intake.PARSERS["ing"], ing_parser.parse_ing_pdf)


if __name__ == "__main__":
    unittest.main()
