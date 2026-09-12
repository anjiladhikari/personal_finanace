"""ING PDF statement parser.

Reads an ING Orange Everyday statement PDF and returns the statement period,
opening/closing balances and every transaction. Money is integer cents.
Output shape matches commbank_parser.parse_commbank_pdf.

ING issues two layouts; both are handled (verified against real statements):

Periodic "Orange Everyday statement"
- "Statement from: DD/MM/YYYY to DD/MM/YYYY" and a page-1 summary line
  "Opening balance | Total money in | Total money out | Closing balance".
- Header  Date | Details | Money out $ | Money in $ | Balance $  on every
  table page. Amounts are LEFT-aligned at their column and sit on the
  transaction's first line; money out carries its own "-" sign.
- The table ends at the "Total Cashback ..." summary rows.

"Interim statement"
- "Statement Start Date D Mon YYYY" / "Statement End Date D Mon YYYY".
- Header  Date | Description | Deposit($) | Withdrawal($) | Balance($)  on
  page 1 only; later pages start directly with rows. Amounts are
  RIGHT-aligned to the header, withdrawals read "-$x.xx".
- A "Brought Forward" row opens the table and "Closing Balance" closes it.

Common to both: a transaction starts with a date in the Date column, wrapped
description lines start in the Details column, rows run chronologically with
a running balance, and every row has exactly one money-out or money-in value.
"""

import os
import re
import sys
from datetime import date

import pdfplumber


class INGParseError(Exception):
    """The PDF does not match the expected ING statement layout."""


class INGValidationError(Exception):
    """The parsed figures do not reconcile."""


MONTHS = {
    "Jan": 1, "Feb": 2, "Mar": 3, "Apr": 4, "May": 5, "Jun": 6,
    "Jul": 7, "Aug": 8, "Sep": 9, "Oct": 10, "Nov": 11, "Dec": 12,
}

PERIODIC = "periodic"
INTERIM = "interim"
HEADERS = {
    PERIODIC: ["Date", "Details", "Money", "out", "$", "Money", "in", "$", "Balance", "$"],
    INTERIM: ["Date", "Description", "Deposit($)", "Withdrawal($)", "Balance($)"],
}

LINE_TOLERANCE = 3.0    # words whose top is within this many pt share a line
COLUMN_TOLERANCE = 2.0  # how far a cell may sit from its column edge

MONEY_RE = re.compile(r"^(-?)\$?(-?)(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})$")
SLASH_DATE_RE = re.compile(r"^(\d{2})/(\d{2})/(\d{4})$")
WORD_DATE_RE = re.compile(r"^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})$")
PERIOD_RE = re.compile(r"Statement from: (\d{2}/\d{2}/\d{4}) to (\d{2}/\d{2}/\d{4})$")
START_RE = re.compile(r"Statement Start Date (\d{1,2} [A-Z][a-z]{2} \d{4})$")
END_RE = re.compile(r"Statement End Date (\d{1,2} [A-Z][a-z]{2} \d{4})$")
SUMMARY_LABELS = ["Opening", "balance", "Total", "money", "in", "Total", "money", "out", "Closing", "balance"]


# --------------------------------------------------------------------------
# Small pure helpers
# --------------------------------------------------------------------------

def money_cents(text):
    """'12.00' -> 1200, '-12.00' / '-$12.00' / '$-12.00' -> -1200, '$1,234.56' -> 123456."""
    m = MONEY_RE.match(text)
    if not m or (m.group(1) and m.group(2)):
        raise INGParseError(f"cannot parse amount {text!r}")
    cents = int(m.group(3).replace(",", "")) * 100 + int(m.group(4))
    return -cents if (m.group(1) or m.group(2)) else cents


def parse_date(text):
    """'05/01/2026' (day/month/year) or '5 Jan 2026' -> date(2026, 1, 5)."""
    m = SLASH_DATE_RE.match(text)
    if m:
        day, month, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
    else:
        m = WORD_DATE_RE.match(text)
        if not m or m.group(2) not in MONTHS:
            raise INGParseError(f"cannot interpret date {text!r}")
        day, month, year = int(m.group(1)), MONTHS[m.group(2)], int(m.group(3))
    try:
        return date(year, month, day)
    except ValueError:
        raise INGParseError(f"invalid calendar date {text!r}") from None


def signed_amount(money_out, money_in):
    """Signed cents from the Money out / Money in cells (exactly one must be given)."""
    if (money_out is None) == (money_in is None):
        raise INGParseError("expected exactly one of Money out / Money in")
    if money_out is not None:
        amount = money_cents(money_out)
        if amount > 0:
            raise INGParseError(f"Money out value {money_out!r} is not negative")
        return amount
    amount = money_cents(money_in)
    if amount < 0:
        raise INGParseError(f"Money in value {money_in!r} is negative")
    return amount


# --------------------------------------------------------------------------
# Page geometry
# --------------------------------------------------------------------------

def _page_lines(page):
    """Group a page's upright words into visual lines, top to bottom, left to right."""
    words = [w for w in page.extract_words() if w["upright"]]
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
    """Column positions taken from a statement's table header row."""

    def __init__(self, header_words, kind):
        self.kind = kind
        self.date_x0 = header_words[0]["x0"]
        self.details_x0 = header_words[1]["x0"]
        if kind == PERIODIC:
            # Cells are left-aligned: match on the word's left edge.
            self.edge = "x0"
            self.edges = {
                "out": header_words[2]["x0"],
                "in": header_words[5]["x0"],
                "balance": header_words[8]["x0"],
            }
        else:
            # Cells are right-aligned: match on the word's right edge.
            self.edge = "x1"
            self.edges = {
                "in": header_words[2]["x1"],
                "out": header_words[3]["x1"],
                "balance": header_words[4]["x1"],
            }

    def cell(self, word):
        """'out' / 'in' / 'balance' if the word sits in a money column, else None."""
        for name, x in self.edges.items():
            if abs(word[self.edge] - x) <= COLUMN_TOLERANCE:
                return name
        return None

    def date_token_count(self):
        return 1 if self.kind == PERIODIC else 3


def _find_header(lines):
    for index, line in enumerate(lines):
        texts = [w["text"] for w in line]
        for kind, header in HEADERS.items():
            if texts == header:
                return index, kind
    return None


def _is_row_date(texts, kind):
    if kind == PERIODIC:
        return SLASH_DATE_RE.match(texts[0]) is not None
    return len(texts) >= 3 and WORD_DATE_RE.match(" ".join(texts[:3])) is not None


def _row_role(columns, words):
    """'date', 'continuation', 'opening', 'closing', or None for a non-table line."""
    texts = [w["text"] for w in words]
    if abs(words[0]["x0"] - columns.date_x0) <= COLUMN_TOLERANCE:
        return "date" if _is_row_date(texts, columns.kind) else None
    if abs(words[0]["x0"] - columns.details_x0) <= COLUMN_TOLERANCE:
        return "continuation"
    if columns.kind == INTERIM and texts[:2] == ["Brought", "Forward"]:
        return "opening"
    if columns.kind == INTERIM and texts[:2] == ["Closing", "Balance"]:
        return "closing"
    return None


# --------------------------------------------------------------------------
# Rows -> transaction blocks
# --------------------------------------------------------------------------

class _Block:
    """One table entry: a date row plus its wrapped description lines."""

    def __init__(self, page_no, columns, words):
        self.page_no = page_no
        self.columns = columns
        n = columns.date_token_count()
        self.date = parse_date(" ".join(w["text"] for w in words[:n]))
        self.description = []
        self.cells = {"out": [], "in": [], "balance": []}
        self.add(words[n:])

    def add(self, words):
        for word in words:
            cell = self.columns.cell(word)
            if cell:
                self.cells[cell].append(word["text"])
            else:
                self.description.append(word["text"])

    def where(self):
        return f"page {self.page_no}, row dated {self.date.isoformat()}"


def _single_cell(block, name, label):
    values = block.cells[name]
    if len(values) != 1:
        raise INGParseError(f"{block.where()}: expected one {label} value, found {len(values)}")
    return values[0]


def _balance_cell(columns, words, page_no, label):
    values = [w["text"] for w in words if columns.cell(w) == "balance"]
    if len(values) != 1:
        raise INGParseError(f"page {page_no}: {label} row has no single balance value")
    return money_cents(values[0])


def _read_table(pages):
    """Walk the pages and return (kind, blocks, opening, closing).

    opening/closing are only filled from the interim "Brought Forward" and
    "Closing Balance" rows; the periodic layout reports them elsewhere.
    """
    columns = None
    blocks = []
    opening = closing = None
    finished = False
    for page_no, lines in enumerate(pages, start=1):
        header = _find_header(lines)
        if header is not None:
            index, kind = header
            if columns is not None and (finished or kind == INTERIM or columns.kind != kind):
                raise INGParseError(f"page {page_no}: second transaction table found")
            columns = _Columns(lines[index], kind)
            body = lines[index + 1:]
        elif columns is None:
            continue  # pages before the table
        elif columns.kind == PERIODIC:
            finished = True  # periodic layout repeats the header on every table page
            continue
        else:
            body = lines  # interim continuation page

        in_rows = not finished
        for words in body:
            role = _row_role(columns, words)
            if role is None:
                in_rows = False  # footer / summary: this page's rows are over
                continue
            if not in_rows:
                raise INGParseError(f"page {page_no}: table row found after the table ended")
            if role == "date":
                if columns.kind == INTERIM and opening is None:
                    raise INGParseError(f"page {page_no}: transaction before Brought Forward row")
                blocks.append(_Block(page_no, columns, words))
            elif role == "continuation":
                if not blocks:
                    raise INGParseError(f"page {page_no}: description line before any transaction")
                blocks[-1].add(words)
            elif role == "opening":
                if opening is not None or blocks:
                    raise INGParseError(f"page {page_no}: unexpected Brought Forward row")
                opening = _balance_cell(columns, words, page_no, "Brought Forward")
            else:  # closing
                closing = _balance_cell(columns, words, page_no, "Closing Balance")
                finished = True
                in_rows = False

    if columns is None:
        raise INGParseError("transaction table header not found")
    if columns.kind == INTERIM and closing is None:
        raise INGParseError("Closing Balance row not found")
    return columns.kind, blocks, opening, closing


# --------------------------------------------------------------------------
# Statement metadata
# --------------------------------------------------------------------------

def _line_texts(pages):
    for lines in pages:
        for line in lines:
            yield line, " ".join(w["text"] for w in line)


def _periodic_metadata(pages):
    """(start, end, opening, total_in, total_out, closing) from the page-1 summary."""
    period = summary = None
    for lines in pages:
        for index, line in enumerate(lines):
            text = " ".join(w["text"] for w in line)
            m = PERIOD_RE.search(text)
            if m and period is None:
                period = (parse_date(m.group(1)), parse_date(m.group(2)))
            if [w["text"] for w in line] == SUMMARY_LABELS and summary is None:
                if index + 1 >= len(lines):
                    raise INGParseError("balance summary values not found")
                values = [w["text"] for w in lines[index + 1]]
                if len(values) != 4:
                    raise INGParseError(f"balance summary has {len(values)} values, expected 4")
                summary = [money_cents(v) for v in values]
        if period and summary:
            return (*period, *summary)
    if period is None:
        raise INGParseError("statement period ('Statement from: ... to ...') not found")
    raise INGParseError("balance summary (Opening balance ... Closing balance) not found")


def _interim_period(pages):
    start = end = None
    for _, text in _line_texts(pages):
        m = START_RE.search(text)
        if m and start is None:
            start = parse_date(m.group(1))
        m = END_RE.search(text)
        if m and end is None:
            end = parse_date(m.group(1))
    if start is None or end is None:
        raise INGParseError("Statement Start Date / Statement End Date not found")
    return start, end


# --------------------------------------------------------------------------
# Public entry point
# --------------------------------------------------------------------------

def parse_ing_pdf(pdf_path):
    """Parse an ING statement PDF.

    Returns a dict with statement_start_date, statement_end_date,
    opening_balance, closing_balance and a list of transactions, each
    {"date", "description", "amount", "balance"}. Dates are ISO strings,
    money is integer cents. Raises INGParseError or INGValidationError
    rather than returning questionable data.
    """
    with pdfplumber.open(pdf_path) as pdf:
        pages = [_page_lines(page) for page in pdf.pages]

    kind, blocks, opening, closing = _read_table(pages)
    totals = None
    if kind == PERIODIC:
        start, end, opening, total_in, total_out, closing = _periodic_metadata(pages)
        totals = (total_in, total_out)
    else:
        start, end = _interim_period(pages)

    transactions = []
    running = opening
    for block in blocks:
        if not start <= block.date <= end:
            raise INGParseError(f"{block.where()}: date outside statement period {start} - {end}")
        out = block.cells["out"]
        in_ = block.cells["in"]
        if len(out) > 1 or len(in_) > 1:
            raise INGParseError(f"{block.where()}: more than one value in a money column")
        try:
            amount = signed_amount(out[0] if out else None, in_[0] if in_ else None)
        except INGParseError as exc:
            raise INGParseError(f"{block.where()}: {exc}") from None
        balance = money_cents(_single_cell(block, "balance", "Balance"))
        running += amount
        if running != balance:
            raise INGValidationError(
                f"{block.where()}: running balance {running} does not match "
                f"statement balance {balance}"
            )
        transactions.append({
            "date": block.date.isoformat(),
            "description": " ".join(block.description),
            "amount": amount,
            "balance": balance,
        })

    total = sum(t["amount"] for t in transactions)
    if opening + total != closing:
        raise INGValidationError(
            f"opening {opening} + transactions {total} = {opening + total}, "
            f"but closing balance is {closing}"
        )
    if totals is not None:
        money_in = sum(t["amount"] for t in transactions if t["amount"] > 0)
        money_out = sum(t["amount"] for t in transactions if t["amount"] < 0)
        if (money_in, money_out) != totals:
            raise INGValidationError(
                f"money in/out {money_in}/{money_out} do not match the statement "
                f"totals {totals[0]}/{totals[1]}"
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
            result = parse_ing_pdf(path)
        except (INGParseError, INGValidationError) as exc:
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
        print("usage: python3 ing_parser.py STATEMENT.pdf [...]")
        sys.exit(2)
    sys.exit(main(sys.argv[1:]))
