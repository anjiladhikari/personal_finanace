"""Internal-transfer identification and separation (Step 8).

Money moved between the user's own accounts is neither spending nor income.
A transaction is internal when the categoriser (Step 7) gave it the type
"Internal Transfer" via an explicit rule; nothing is inferred from amounts,
descriptions, dates, bank names or opposite transactions.

This module needs no database. It returns copies and never mutates input.
"""

INTERNAL_TRANSFER_TYPE = "Internal Transfer"


def is_internal_transfer(transaction):
    """True only when the categorised type is "Internal Transfer" (case/whitespace-insensitive)."""
    type_ = transaction.get("type")
    return isinstance(type_, str) and type_.strip().casefold() == INTERNAL_TRANSFER_TYPE.casefold()


def mark_internal_transfer(transaction):
    """Copy of a categorised transaction with is_internal added; the type text is untouched."""
    marked = dict(transaction)
    marked["is_internal"] = is_internal_transfer(transaction)
    return marked


def mark_internal_transfers(transactions):
    """Mark each categorised transaction, in input order."""
    return [mark_internal_transfer(transaction) for transaction in transactions]


def split_internal_transfers(transactions):
    """(normal, internal): marked copies, each list in input order, nothing lost or duplicated."""
    normal, internal = [], []
    for marked in mark_internal_transfers(transactions):
        (internal if marked["is_internal"] else normal).append(marked)
    return normal, internal
