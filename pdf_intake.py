"""PDF intake: validate an uploaded statement and route it to the right parser.

This is the plain-Python layer a future HTTP endpoint will call. It does no
parsing itself: the frozen bank parsers own transaction extraction, financial
validation and the normalised output. Nothing is copied, stored or written to
disk here; the caller's file is read in place by the parser.
"""

from pathlib import Path

import commbank_parser
import ing_parser


class PDFIntakeError(Exception):
    """The upload cannot be handed to a parser (bad bank, path, extension, empty file)."""


# The only place a bank name maps to a parser. Keys are the normalised names.
PARSERS = {
    "commbank": commbank_parser.parse_commbank_pdf,
    "ing": ing_parser.parse_ing_pdf,
}


def normalize_bank(bank):
    """'CommBank' / ' ING ' -> 'commbank' / 'ing'; anything else is rejected."""
    if not isinstance(bank, str):
        raise PDFIntakeError(f"unsupported bank {bank!r}; choose one of {sorted(PARSERS)}")
    name = bank.strip().lower()
    if name not in PARSERS:
        raise PDFIntakeError(f"unsupported bank {bank!r}; choose one of {sorted(PARSERS)}")
    return name


def _validate_pdf_path(file_path):
    path = Path(file_path)
    if not path.exists():
        raise PDFIntakeError(f"file not found: {path}")
    if not path.is_file():
        raise PDFIntakeError(f"not a file: {path}")
    if path.suffix.lower() != ".pdf":
        raise PDFIntakeError(f"not a .pdf file: {path.name}")
    if path.stat().st_size == 0:
        raise PDFIntakeError(f"file is empty: {path.name}")
    return path


def process_pdf(file_path, bank):
    """Parse the statement at file_path with the parser for the chosen bank.

    Returns the parser's own validated result unchanged:
    {statement_start_date, statement_end_date, opening_balance,
     closing_balance, transactions}. Raises PDFIntakeError for intake
    problems; parser errors (CommBankParseError, INGValidationError, ...)
    propagate untouched so the failure stays specific.
    """
    parse = PARSERS[normalize_bank(bank)]
    path = _validate_pdf_path(file_path)
    return parse(path)
