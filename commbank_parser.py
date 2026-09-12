"""CommBank PDF statement parser.

Reads a CommBank account statement PDF and returns the statement period,
opening/closing balances and every transaction. Money is integer cents.

Layout facts this parser relies on (verified against real statements):

- A "Period D Mon YYYY - D Mon YYYY" line gives the statement period, which
  supplies the year for the day/month-only transaction dates.
- Every table page has the header row  Date | Transaction | Debit | Credit | Balance
  and amounts are right-aligned under their column header.
- A transaction starts with "DD Mon" in the Date column. Wrapped description
  lines start in the Transaction column. Amounts sit on the block's last line.
- The first table row is "OPENING BALANCE" and the last is "CLOSING BALANCE".
  Balances read "Nil", "$12.34CR", "$12.34 CR", "12.34 DR" or "$0.00".
- A stray currency glyph ("$", sometimes rendered "(") floats between the
  Debit and Credit columns on its own baseline and must be ignored.
- A dated row with no Debit, Credit or Balance cell at all is an
  informational notice (e.g. a nil interest charge), not a transaction.
- Some statements contain no space characters at all, so words are split by
  horizontal gap rather than by whitespace.
"""

import os
import re
import sys
from datetime import date

import pdfplumber


class CommBankParseError(Exception):
    """The PDF does not match the expected CommBank statement layout."""


class CommBankValidationError(Exception):
    """The parsed figures do not reconcile."""


MONTHS = {
    "Jan": 1, "Feb": 2, "Mar": 3, "Apr": 4, "May": 5, "Jun": 6,
    "Jul": 7, "Aug": 8, "Sep": 9, "Oct": 10, "Nov": 11, "Dec": 12,
}

HEADER = ["Date", "Transaction", "Debit", "Credit", "Balance"]

X_TOLERANCE = 1.0       # horizontal gap (pt) that separates two words
LINE_TOLERANCE = 3.0    # words whose top is within this many pt share a line
COLUMN_TOLERANCE = 2.0  # how far a row may start from its column's left edge

PERIOD_RE = re.compile(
    r"^Period (\d{1,2}) ([A-Z][a-z]{2}) (\d{4}) - (\d{1,2}) ([A-Z][a-z]{2}) (\d{4})$"
)
MONEY_RE = re.compile(r"^\$?(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})$")
BALANCE_RE = re.compile(r"^\$?(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})(CR|DR)?$")


# --------------------------------------------------------------------------
# Small pure helpers
# --------------------------------------------------------------------------

def money_cents(text):
    """'1,405.00' or '$1,405.00' -> 140500."""
    m = MONEY_RE.match(text)
    if not m:
        raise CommBankParseError(f"cannot parse amount {text!r}")
    return int(m.group(1).replace(",", "")) * 100 + int(m.group(2))


def balance_cents(text):
    """'Nil' -> 0, '$62.64CR' -> 6264, '10.25DR' -> -1025, '$0.00' -> 0."""
    if text == "Nil":
        return 0
    m = BALANCE_RE.match(text)
    if not m:
        raise CommBankParseError(f"cannot interpret balance {text!r}")
    cents = int(m.group(1).replace(",", "")) * 100 + int(m.group(2))
    suffix = m.group(3)
    if suffix == "CR":
        return cents
    if suffix == "DR":
        return -cents
    if cents == 0:
        return 0
    raise CommBankParseError(f"balance {text!r} has no CR/DR suffix")


def resolve_date(day, month, start, end):
    """Give a day/month its year using the statement period.

    Exactly one of the period's years must place the date inside the period;
    otherwise the year cannot be determined and we refuse to guess.
    """
    candidates = []
    for year in sorted({start.year, end.year}):
        try:
            candidate = date(year, month, day)
        except ValueError:
            continue
        if start <= candidate <= end:
            candidates.append(candidate)
    if len(candidates) != 1:
        raise CommBankParseError(
            f"cannot determine year for {day:02d}/{month:02d} "
            f"within statement period {start} - {end}"
        )
    return candidates[0]


def _period_date(day, month_name, year):
    if month_name not in MONTHS:
        raise CommBankParseError(f"unknown month {month_name!r} in statement period")
    return date(int(year), MONTHS[month_name], int(day))


# --------------------------------------------------------------------------
# Page geometry
# --------------------------------------------------------------------------

def _page_lines(page):
    """Group a page's words into visual lines, top to bottom, left to right.

    Rotated words are ignored: statements carry a vertical print-control
    string in the left margin that is not part of the table.
    """
    words = [w for w in page.extract_words(x_tolerance=X_TOLERANCE) if w["upright"]]
    words.sort(key=lambda w: w["top"])
    lines = []
    for word in words:
        if lines and word["top"] - lines[-1][0]["top"] <= LINE_TOLERANCE:
            lines[-1].append(word)
        else:
            lines.append([word])
    for line in lines:
        line.sort(key=lambda w: w["x0"])
    return lines


class _Columns:
    """Column edges taken from a page's table header row."""

    def __init__(self, header_words):
        by_name = {w["text"]: w for w in header_words}
        self.date_x0 = by_name["Date"]["x0"]
        self.transaction_x0 = by_name["Transaction"]["x0"]
        # Any word whose right edge reaches the Debit column is an amount.
        self.amount_x = by_name["Debit"]["x0"]
        debit_x1 = by_name["Debit"]["x1"]
        credit_x1 = by_name["Credit"]["x1"]
        balance_x1 = by_name["Balance"]["x1"]
        self.debit_credit_split = (debit_x1 + credit_x1) / 2
        self.credit_balance_split = (credit_x1 + balance_x1) / 2

    def is_amount(self, word):
        return word["x1"] >= self.amount_x

    def amount_column(self, word):
        if word["x1"] <= self.debit_credit_split:
            return "debit"
        if word["x1"] <= self.credit_balance_split:
            return "credit"
        return "balance"


def _find_header(lines):
    for index, line in enumerate(lines):
        texts = [w["text"] for w in line]
        if texts[-5:] == HEADER:
            return index
    return None


def _find_period(pages):
    for lines in pages:
        for line in lines:
            m = PERIOD_RE.match(" ".join(w["text"] for w in line))
            if m:
                return (_period_date(*m.group(1, 2, 3)), _period_date(*m.group(4, 5, 6)))
    raise CommBankParseError("statement period not found")


def _table_rows(pages):
    """Yield (page_no, columns, words) for every table line up to CLOSING BALANCE."""
    started = False
    for page_no, lines in enumerate(pages, start=1):
        header_index = _find_header(lines)
        if header_index is None:
            if started:
                raise CommBankParseError(
                    f"page {page_no}: table header not found before CLOSING BALANCE row"
                )
            continue
        started = True
        columns = _Columns(lines[header_index][-5:])
        for words in lines[header_index + 1:]:
            yield page_no, columns, words
            if _row_label(columns, words) == "CLOSING BALANCE":
                return
    if started:
        raise CommBankParseError("CLOSING BALANCE row not found")
    raise CommBankParseError("transaction table header not found")


def _is_day_month(words):
    return (
        len(words) >= 2
        and re.fullmatch(r"\d{1,2}", words[0]["text"]) is not None
        and words[1]["text"] in MONTHS
    )


def _row_label(columns, words):
    """'OPENING BALANCE' / 'CLOSING BALANCE' for the boundary rows, else None."""
    texts = [w["text"] for w in words if not columns.is_amount(w)]
    if not _is_day_month(words):
        return None
    texts = texts[2:]
    if texts and re.fullmatch(r"\d{4}", texts[0]):
        texts = texts[1:]
    label = " ".join(texts[:2])
    return label if label in ("OPENING BALANCE", "CLOSING BALANCE") else None


# --------------------------------------------------------------------------
# Rows -> transaction blocks
# --------------------------------------------------------------------------

class _Block:
    """One table entry: a date row plus its continuation lines."""

    def __init__(self, page_no, columns, words):
        self.page_no = page_no
        self.columns = columns
        self.label = _row_label(columns, words)
        self.day = int(words[0]["text"])
        self.month = MONTHS[words[1]["text"]]
        self.description = []
        self.amounts = {"debit": [], "credit": [], "balance": []}
        self.add(words[2:])

    def add(self, words):
        for word in words:
            text = word["text"]
            if not self.columns.is_amount(word):
                self.description.append(text)
            elif len(text) == 1 and not text.isalnum():
                continue  # stray currency glyph
            else:
                self.amounts[self.columns.amount_column(word)].append(text)

    def where(self):
        return f"page {self.page_no}, row dated {self.day:02d}/{self.month:02d}"


def _blocks(rows):
    blocks = []
    for page_no, columns, words in rows:
        first = words[0]
        if abs(first["x0"] - columns.date_x0) <= COLUMN_TOLERANCE:
            if not _is_day_month(words):
                raise CommBankParseError(
                    f"page {page_no}: row in the Date column does not start with a date"
                )
            blocks.append(_Block(page_no, columns, words))
        elif abs(first["x0"] - columns.transaction_x0) <= COLUMN_TOLERANCE:
            if not blocks:
                raise CommBankParseError(f"page {page_no}: description line before any transaction")
            blocks[-1].add(words)
        else:
            raise CommBankParseError(
                f"page {page_no}: ambiguous row starting at x={first['x0']:.1f}"
            )
    return blocks


def _block_balance(block):
    tokens = block.amounts["balance"]
    if not tokens:
        raise CommBankParseError(f"{block.where()}: no balance")
    return balance_cents("".join(tokens))


def _block_amount(block):
    debit, credit = block.amounts["debit"], block.amounts["credit"]
    if len(debit) + len(credit) != 1:
        raise CommBankParseError(
            f"{block.where()}: expected exactly one Debit or Credit value, "
            f"found {len(debit)} debit and {len(credit)} credit"
        )
    return -money_cents(debit[0]) if debit else money_cents(credit[0])


# --------------------------------------------------------------------------
# Public entry point
# --------------------------------------------------------------------------

def parse_commbank_pdf(pdf_path):
    """Parse a CommBank statement PDF.

    Returns a dict with statement_start_date, statement_end_date,
    opening_balance, closing_balance and a list of transactions, each
    {"date", "description", "amount", "balance"}. Dates are ISO strings,
    money is integer cents. Raises CommBankParseError or
    CommBankValidationError rather than returning questionable data.
    """
    with pdfplumber.open(pdf_path) as pdf:
        pages = [_page_lines(page) for page in pdf.pages]

    start, end = _find_period(pages)
    blocks = _blocks(_table_rows(pages))

    if not blocks or blocks[0].label != "OPENING BALANCE":
        raise CommBankParseError("first table row is not OPENING BALANCE")
    if blocks[-1].label != "CLOSING BALANCE":
        raise CommBankParseError("last table row is not CLOSING BALANCE")
    for block in blocks[1:-1]:
        if block.label:
            raise CommBankParseError(f"{block.where()}: unexpected {block.label} row")

    opening = _block_balance(blocks[0])
    closing = _block_balance(blocks[-1])

    transactions = []
    running = opening
    for block in blocks[1:-1]:
        if not any(block.amounts.values()):
            # A dated notice with no Debit, Credit or Balance cell (for example
            # "DEBIT INTEREST CHARGED ... is 0.00") is not a transaction.
            continue
        amount = _block_amount(block)
        balance = _block_balance(block)
        running += amount
        if running != balance:
            raise CommBankValidationError(
                f"{block.where()}: running balance {running} does not match "
                f"statement balance {balance}"
            )
        transactions.append({
            "date": resolve_date(block.day, block.month, start, end).isoformat(),
            "description": " ".join(block.description),
            "amount": amount,
            "balance": balance,
        })

    total = sum(t["amount"] for t in transactions)
    if opening + total != closing:
        raise CommBankValidationError(
            f"opening {opening} + transactions {total} = {opening + total}, "
            f"but closing balance is {closing}"
        )

    return {
        "statement_start_date": start.isoformat(),
        "statement_end_date": end.isoformat(),
        "opening_balance": opening,
        "closing_balance": closing,
        "transactions": transactions,
    }


def main(paths):
    """Parse each PDF and print a one-line summary. Never prints transactions."""
    failed = False
    for path in paths:
        name = os.path.basename(path)
        try:
            result = parse_commbank_pdf(path)
        except (CommBankParseError, CommBankValidationError) as exc:
            failed = True
            print(f"{name}: FAIL - {exc}")
            continue
        print(
            f"{name}: {len(result['transactions'])} transactions, "
            f"{result['statement_start_date']} to {result['statement_end_date']}, "
            f"validation PASS"
        )
    return 1 if failed else 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: python3 commbank_parser.py STATEMENT.pdf [...]")
        sys.exit(2)
    sys.exit(main(sys.argv[1:]))
