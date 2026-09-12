"""Step 3 dev tests for the pure helpers in ing_parser.

Real statement PDFs are private and never live in the repo; the full
regression run against them is a later step. These tests only pin down the
deterministic money, date and sign rules with made-up values.
"""

import unittest
from datetime import date

from ing_parser import INGParseError, money_cents, parse_date, signed_amount


class MoneyCentsTests(unittest.TestCase):
    def test_positive_forms(self):
        self.assertEqual(money_cents("12.00"), 1200)
        self.assertEqual(money_cents("$12.00"), 1200)
        self.assertEqual(money_cents("$1,234.56"), 123456)
        self.assertEqual(money_cents("0.00"), 0)

    def test_negative_forms_seen_on_ing_statements(self):
        self.assertEqual(money_cents("-12.00"), -1200)     # periodic table cell
        self.assertEqual(money_cents("-$12.00"), -1200)    # interim table cell
        self.assertEqual(money_cents("$-1,234.56"), -123456)  # periodic summary total

    def test_rejects_non_amounts(self):
        for text in ("", "$", "12", "12.3", "abc", "1,2.00", "--12.00", "-$-12.00"):
            with self.assertRaises(INGParseError):
                money_cents(text)


class ParseDateTests(unittest.TestCase):
    def test_slash_dates_are_day_first(self):
        self.assertEqual(parse_date("05/01/2026"), date(2026, 1, 5))
        self.assertEqual(parse_date("31/12/2025"), date(2025, 12, 31))

    def test_day_month_year_words(self):
        self.assertEqual(parse_date("5 Jan 2026"), date(2026, 1, 5))
        self.assertEqual(parse_date("28 Feb 2026"), date(2026, 2, 28))

    def test_rejects_unsupported_or_impossible_dates(self):
        for text in ("2026-01-05", "05/01/26", "5 Foo 2026", "31/02/2026", "29 Feb 2025", ""):
            with self.assertRaises(INGParseError):
                parse_date(text)


class SignedAmountTests(unittest.TestCase):
    def test_money_out_is_negative(self):
        self.assertEqual(signed_amount("-12.00", None), -1200)
        self.assertEqual(signed_amount("-$12.00", None), -1200)

    def test_money_in_is_positive(self):
        self.assertEqual(signed_amount(None, "50.00"), 5000)
        self.assertEqual(signed_amount(None, "$50.00"), 5000)

    def test_both_or_neither_is_rejected(self):
        with self.assertRaises(INGParseError):
            signed_amount("-12.00", "50.00")
        with self.assertRaises(INGParseError):
            signed_amount(None, None)

    def test_sign_must_agree_with_column(self):
        with self.assertRaises(INGParseError):
            signed_amount("12.00", None)      # money out shown positive
        with self.assertRaises(INGParseError):
            signed_amount(None, "-50.00")     # money in shown negative


if __name__ == "__main__":
    unittest.main()
