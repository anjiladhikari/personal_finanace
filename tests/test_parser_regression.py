"""Step 4: real-PDF regression suite and parser freeze gate.

Parsers are regression-frozen after Step 4. Any future change to
commbank_parser.py or ing_parser.py must run this complete real-PDF
regression suite and every statement must still pass.

The reference statements are private and live only in the git-ignored
test_pdfs/ folder. This file stores structural expectations only —
filename pattern, transaction count and statement period — never amounts,
balances, descriptions or account numbers. (Two ING filenames embed the
account number, so those are matched by glob rather than spelled out.)

Behaviour on a machine without the private folder:
- neither test_pdfs/commbank nor test_pdfs/ing exists -> the whole suite is
  skipped, so a public clone can still run the unit tests
- otherwise every expected statement is mandatory: a missing file, an extra
  unregistered file, or any parse/validation failure FAILS the suite
"""

import re
import unittest
from datetime import date
from pathlib import Path

from commbank_parser import parse_commbank_pdf
from ing_parser import parse_ing_pdf

PDF_ROOT = Path(__file__).resolve().parent.parent / "test_pdfs"
COMMBANK_DIR = PDF_ROOT / "commbank"
ING_DIR = PDF_ROOT / "ing"
PRIVATE_PDFS_PRESENT = COMMBANK_DIR.is_dir() or ING_DIR.is_dir()

# filename glob -> (transaction count, statement start, statement end)
COMMBANK_EXPECTED = {
    "c1.pdf": (237, "2024-02-13", "2024-08-13"),
    "c2.pdf": (407, "2024-09-01", "2025-02-28"),
    "c3.pdf": (22, "2024-08-14", "2024-08-31"),
    "c4.pdf": (369, "2025-09-01", "2026-02-23"),
    "c5.pdf": (18, "2026-02-24", "2026-02-28"),
    "c6.pdf": (388, "2025-03-01", "2025-08-31"),
    "c7.pdf": (206, "2026-03-01", "2026-08-31"),
}
ING_EXPECTED = {
    "ing1.pdf": (6, "2025-09-07", "2025-09-30"),
    "ing2.pdf": (27, "2025-10-01", "2025-12-31"),
    "ing 3.pdf": (69, "2026-01-01", "2026-03-31"),
    "ing 4.pdf": (211, "2026-04-01", "2026-06-30"),
    "Orange_Everyday_*_2026-04-01_2026-06-30.pdf": (39, "2026-04-01", "2026-06-30"),
    "ing last.pdf": (214, "2026-07-01", "2026-09-11"),
    "Orange_Everyday_*_2026-07-01_2026-07-13.pdf": (5, "2026-07-01", "2026-07-13"),
}

ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TRANSACTION_KEYS = {"date", "description", "amount", "balance"}
STATEMENT_KEYS = {
    "statement_start_date", "statement_end_date",
    "opening_balance", "closing_balance", "transactions",
}


def _resolve(directory, pattern):
    """The single reference PDF matching pattern; missing or ambiguous is a failure."""
    matches = sorted(directory.glob(pattern))
    if len(matches) != 1:
        raise AssertionError(
            f"expected exactly one reference PDF matching {pattern!r} in {directory}, "
            f"found {len(matches)}"
        )
    return matches[0]


def _is_int(value):
    # bool is a subclass of int; money must be a real int and never a float
    return type(value) is int


class _RegressionChecks:
    """Shared checks, mixed into one TestCase per bank.

    longMessage is off so a failure prints only our message, never the
    repr of a transaction, description or balance.
    """

    longMessage = False

    bank = None
    directory = None
    expected = None
    parse = None

    def check_statement(self, pattern, expected):
        count, start, end = expected
        path = _resolve(self.directory, pattern)
        result = self.parse(path)  # raises the parser's own error on any failure
        label = f"{self.bank} {pattern}"

        self.assertEqual(set(result), STATEMENT_KEYS, f"{label}: statement keys {sorted(result)}")
        self.assertEqual(
            result["statement_start_date"], start,
            f"{label}: start date {result['statement_start_date']!r} != {start!r}",
        )
        self.assertEqual(
            result["statement_end_date"], end,
            f"{label}: end date {result['statement_end_date']!r} != {end!r}",
        )
        self.assertLessEqual(start, end, f"{label}: period order")
        self.assertTrue(_is_int(result["opening_balance"]), f"{label}: opening balance not int")
        self.assertTrue(_is_int(result["closing_balance"]), f"{label}: closing balance not int")

        transactions = result["transactions"]
        self.assertTrue(isinstance(transactions, list), f"{label}: transactions not a list")
        self.assertGreater(len(transactions), 0, f"{label}: no transactions")
        self.assertEqual(
            len(transactions), count, f"{label}: transaction count {len(transactions)} != {count}"
        )

        running = result["opening_balance"]
        for index, txn in enumerate(transactions):
            where = f"{label}: transaction {index}"
            self.assertTrue(isinstance(txn, dict), f"{where}: not a dict")
            self.assertEqual(set(txn), TRANSACTION_KEYS, f"{where}: keys {sorted(txn)}")
            self.assertTrue(isinstance(txn["date"], str), f"{where}: date not str")
            self.assertRegex(txn["date"], ISO_DATE, f"{where}: date format {txn['date']!r}")
            date.fromisoformat(txn["date"])  # raises if not a real date
            self.assertTrue(
                start <= txn["date"] <= end, f"{where}: date {txn['date']} outside period"
            )
            self.assertTrue(isinstance(txn["description"], str), f"{where}: description not str")
            self.assertTrue(txn["description"].strip(), f"{where}: empty description")
            self.assertTrue(_is_int(txn["amount"]), f"{where}: amount not int")
            self.assertTrue(_is_int(txn["balance"]), f"{where}: balance not int")
            # Independent re-check of the parser's sequential validation.
            running += txn["amount"]
            self.assertEqual(running, txn["balance"], f"{where}: running balance mismatch")

        self.assertEqual(running, result["closing_balance"], f"{label}: closing balance mismatch")

    def test_every_pdf_in_folder_is_registered(self):
        """Every expected pattern matches exactly one file and no PDF is unregistered."""
        self.assertTrue(self.directory.is_dir(), f"{self.bank}: {self.directory} is missing")
        present = {p.name for p in self.directory.glob("*.pdf")}
        registered = {_resolve(self.directory, pattern).name for pattern in self.expected}
        unregistered = sorted(re.sub(r"\d", "#", name) for name in present - registered)
        self.assertEqual(unregistered, [], f"{self.bank}: unregistered PDFs {unregistered}")
        self.assertEqual(
            len(present), len(self.expected),
            f"{self.bank}: {len(present)} reference PDFs, expected {len(self.expected)}",
        )


def _add_statement_tests(cls):
    for pattern, expected in cls.expected.items():
        name = "test_" + re.sub(r"[^0-9a-zA-Z]+", "_", pattern.removesuffix(".pdf")).strip("_")
        if hasattr(cls, name):
            raise ValueError(f"duplicate regression test name {name} for {pattern!r}")
        setattr(cls, name, lambda self, p=pattern, e=expected: self.check_statement(p, e))
    return cls


@_add_statement_tests
@unittest.skipUnless(PRIVATE_PDFS_PRESENT, "private reference PDFs (test_pdfs/) not present")
class CommBankRegressionTests(_RegressionChecks, unittest.TestCase):
    bank = "CommBank"
    directory = COMMBANK_DIR
    expected = COMMBANK_EXPECTED
    parse = staticmethod(parse_commbank_pdf)


@_add_statement_tests
@unittest.skipUnless(PRIVATE_PDFS_PRESENT, "private reference PDFs (test_pdfs/) not present")
class INGRegressionTests(_RegressionChecks, unittest.TestCase):
    bank = "ING"
    directory = ING_DIR
    expected = ING_EXPECTED
    parse = staticmethod(parse_ing_pdf)


if __name__ == "__main__":
    unittest.main()
