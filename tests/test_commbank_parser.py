"""Step 2 dev tests for the pure helpers in commbank_parser.

Real statement PDFs are private and never live in the repo; the full
regression run against them is a later step. These tests only pin down the
deterministic money and date rules with made-up values.
"""

import unittest
from datetime import date

from commbank_parser import (
    CommBankParseError,
    balance_cents,
    money_cents,
    resolve_date,
)


class MoneyCentsTests(unittest.TestCase):
    def test_plain_and_dollar_prefixed(self):
        self.assertEqual(money_cents("33.85"), 3385)
        self.assertEqual(money_cents("$33.85"), 3385)
        self.assertEqual(money_cents("1,405.00"), 140500)
        self.assertEqual(money_cents("$12,345.67"), 1234567)

    def test_rejects_non_amounts(self):
        for text in ("", "abc", "12", "12.3", "$", "1,2.00"):
            with self.assertRaises(CommBankParseError):
                money_cents(text)


class BalanceCentsTests(unittest.TestCase):
    def test_cr_is_positive_and_dr_is_negative(self):
        self.assertEqual(balance_cents("$62.64CR"), 6264)
        self.assertEqual(balance_cents("62.64CR"), 6264)
        self.assertEqual(balance_cents("$10.25DR"), -1025)
        self.assertEqual(balance_cents("$1,234.56DR"), -123456)

    def test_zero_forms(self):
        self.assertEqual(balance_cents("Nil"), 0)
        self.assertEqual(balance_cents("$0.00"), 0)

    def test_nonzero_without_suffix_is_rejected(self):
        with self.assertRaises(CommBankParseError):
            balance_cents("$5.00")


class ResolveDateTests(unittest.TestCase):
    def test_single_year_period(self):
        start, end = date(2024, 2, 13), date(2024, 8, 13)
        self.assertEqual(resolve_date(24, 2, start, end), date(2024, 2, 24))
        self.assertEqual(resolve_date(13, 8, start, end), date(2024, 8, 13))

    def test_period_spanning_two_years(self):
        start, end = date(2024, 9, 1), date(2025, 2, 28)
        self.assertEqual(resolve_date(15, 12, start, end), date(2024, 12, 15))
        self.assertEqual(resolve_date(3, 1, start, end), date(2025, 1, 3))

    def test_date_outside_period_is_rejected(self):
        start, end = date(2024, 9, 1), date(2025, 2, 28)
        with self.assertRaises(CommBankParseError):
            resolve_date(15, 5, start, end)

    def test_impossible_date_is_rejected(self):
        start, end = date(2025, 1, 1), date(2025, 6, 30)
        with self.assertRaises(CommBankParseError):
            resolve_date(29, 2, start, end)


if __name__ == "__main__":
    unittest.main()
