"""FastAPI JSON layer (Step 15).

A thin HTTP layer over the existing backend: routes validate input, call the
domain modules and turn results and known errors into JSON responses.
Business logic lives in importer.py, categories.py, rules.py,
history_validation.py and friends; nothing is reimplemented here.

Run locally with:  uvicorn api:app --reload
"""

import os
import secrets
import shutil
import sqlite3
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path

import pdfplumber.utils.exceptions
from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict

from categories import CategoryError, activate_category, add_category, deactivate_category, list_categories
from commbank_parser import CommBankParseError, CommBankValidationError
from database import DEFAULT_DB_PATH, init_db
from history_validation import (
    HistoryValidationError, validate_date_coverage, validate_import_integrity, validate_storage_totals,
)
from importer import ImportDuplicateError, ImportValidationError, finalize_import, prepare_import
from ing_parser import INGParseError, INGValidationError
from pdf_intake import PDFIntakeError, normalize_bank
from review import ReviewValidationError
from rules import RuleConflictError, RuleValidationError, activate_rule, deactivate_rule, list_rules
from transaction_store import SaveValidationError

DB_PATH = Path(os.environ.get("FINANCE_DB", DEFAULT_DB_PATH))
UPLOAD_DIR = None  # None -> the system temp directory; never inside the repository
ALLOWED_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]
MAX_LIMIT = 1000

PREPARED = {}  # import_token -> prepared import (in memory only; lost on restart)

PARSE_ERRORS = (CommBankParseError, CommBankValidationError, INGParseError, INGValidationError)
TRANSACTION_COLUMNS = ("id", "bank", "date", "raw_description", "merchant", "amount", "balance",
                       "type", "category", "subcategory", "created_at")


@asynccontextmanager
async def lifespan(_app):
    init_db(DB_PATH)
    yield


app = FastAPI(title="Personal Finance", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_methods=["*"], allow_headers=["*"])


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def _db():
    return DB_PATH


def _query(sql, params=()):
    conn = sqlite3.connect(_db())
    try:
        return conn.execute(sql, params).fetchall()
    finally:
        conn.close()


def _iso_date(value, name):
    """Validate an optional YYYY-MM-DD query value."""
    if value is None:
        return None
    from datetime import date
    try:
        if len(value) != 10:
            raise ValueError
        date.fromisoformat(value)
    except (TypeError, ValueError):
        raise HTTPException(400, f"{name} must be YYYY-MM-DD") from None
    return value


def _bank(value):
    try:
        return normalize_bank(value)
    except PDFIntakeError as exc:
        raise HTTPException(400, str(exc)) from None


def _date_clause(start_date, end_date):
    clauses, params = [], []
    if start_date:
        clauses.append("date >= ?")
        params.append(start_date)
    if end_date:
        clauses.append("date <= ?")
        params.append(end_date)
    return clauses, params


# --------------------------------------------------------------------------
# Health
# --------------------------------------------------------------------------

@app.get("/api/health")
def health():
    return {"status": "ok"}


# --------------------------------------------------------------------------
# Imports: prepare -> review (frontend) -> finalize / discard
# --------------------------------------------------------------------------

@app.post("/api/imports/prepare")
def prepare(bank: str = Form(...), file: UploadFile = File(...)):
    bank = _bank(bank)
    original_name = Path(file.filename or "").name or "upload.pdf"
    # The temp file keeps the upload's suffix so intake's ".pdf" rule still applies.
    handle = tempfile.NamedTemporaryFile(suffix=Path(original_name).suffix, dir=UPLOAD_DIR, delete=False)
    tmp_path = Path(handle.name)
    try:
        with handle:
            shutil.copyfileobj(file.file, handle)
        try:
            prepared = prepare_import(_db(), tmp_path, bank)
        except PDFIntakeError:
            # The domain message names the temporary file; never echo it.
            raise HTTPException(400, "Invalid PDF upload") from None
        except ImportDuplicateError:
            raise HTTPException(409, "this PDF has already been imported") from None
        except pdfplumber.utils.exceptions.PdfminerException:
            raise HTTPException(400, "Invalid PDF") from None
        except PARSE_ERRORS as exc:
            raise HTTPException(400, f"statement could not be parsed: {exc}") from None
    finally:
        tmp_path.unlink(missing_ok=True)

    prepared["original_filename"] = original_name
    token = secrets.token_urlsafe(32)
    PREPARED[token] = prepared
    return {
        "import_token": token,
        "bank": prepared["bank"],
        "statement_start_date": prepared["statement_start_date"],
        "statement_end_date": prepared["statement_end_date"],
        "parsed_count": prepared["parsed_count"],
        "review_items": prepared["review_items"],
    }


class FinalizeBody(BaseModel):
    """Only the reviewed items; the prepared import always comes from PREPARED[token]."""
    model_config = ConfigDict(extra="forbid")
    review_items: list[dict]


def _prepared(token):
    if token not in PREPARED:
        raise HTTPException(404, "unknown or expired import token")
    return PREPARED[token]


@app.post("/api/imports/{import_token}/finalize")
def finalize(import_token: str, body: FinalizeBody):
    prepared = _prepared(import_token)
    try:
        summary = finalize_import(_db(), prepared, body.review_items)
    except (ImportValidationError, ReviewValidationError, SaveValidationError, RuleValidationError) as exc:
        raise HTTPException(400, str(exc)) from None
    except ImportDuplicateError as exc:
        raise HTTPException(409, str(exc)) from None
    except RuleConflictError as exc:
        raise HTTPException(409, f"remembered rule conflict: {exc}") from None
    PREPARED.pop(import_token, None)
    return summary


@app.delete("/api/imports/{import_token}")
def discard(import_token: str):
    _prepared(import_token)
    del PREPARED[import_token]
    return {"status": "discarded"}


# --------------------------------------------------------------------------
# Categories
# --------------------------------------------------------------------------

class CategoryBody(BaseModel):
    name: str


def _category_error(exc):
    message = str(exc)
    if "already exists" in message:
        return HTTPException(409, message)
    if message.startswith("unknown category"):
        return HTTPException(404, message)
    return HTTPException(400, message)


@app.get("/api/categories")
def categories(include_inactive: bool = False):
    return list_categories(_db(), include_inactive=include_inactive)


@app.post("/api/categories", status_code=201)
def create_category(body: CategoryBody):
    try:
        return add_category(_db(), body.name)
    except CategoryError as exc:
        raise _category_error(exc) from None


@app.patch("/api/categories/{name}/deactivate")
def category_deactivate(name: str):
    try:
        return deactivate_category(_db(), name)
    except CategoryError as exc:
        raise _category_error(exc) from None


@app.patch("/api/categories/{name}/activate")
def category_activate(name: str):
    try:
        return activate_category(_db(), name)
    except CategoryError as exc:
        raise _category_error(exc) from None


# --------------------------------------------------------------------------
# Rules (created only through reviewed imports)
# --------------------------------------------------------------------------

def _rule_error(exc):
    message = str(exc)
    if isinstance(exc, RuleConflictError):
        return HTTPException(409, message)
    if message.startswith("unknown rule pattern"):
        return HTTPException(404, message)
    return HTTPException(400, message)


@app.get("/api/rules")
def rules(include_inactive: bool = False):
    return list_rules(_db(), include_inactive=include_inactive)


@app.patch("/api/rules/{pattern:path}/deactivate")
def rule_deactivate(pattern: str):
    try:
        return deactivate_rule(_db(), pattern)
    except (RuleValidationError, RuleConflictError) as exc:
        raise _rule_error(exc) from None


@app.patch("/api/rules/{pattern:path}/activate")
def rule_activate(pattern: str):
    try:
        return activate_rule(_db(), pattern)
    except (RuleValidationError, RuleConflictError) as exc:
        raise _rule_error(exc) from None


# --------------------------------------------------------------------------
# Stored transactions and dashboard totals (integer cents throughout)
# --------------------------------------------------------------------------

@app.get("/api/transactions")
def transactions(bank: str | None = None, start_date: str | None = None, end_date: str | None = None,
                 category: str | None = None, limit: int = Query(100, ge=1, le=MAX_LIMIT),
                 offset: int = Query(0, ge=0)):
    clauses, params = _date_clause(_iso_date(start_date, "start_date"), _iso_date(end_date, "end_date"))
    if bank is not None:
        clauses.append("bank = ?")
        params.append(_bank(bank))
    if category is not None:
        clauses.append("category = ?")
        params.append(category)
    where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
    rows = _query(
        f"SELECT {', '.join(TRANSACTION_COLUMNS)} FROM transactions{where} "
        "ORDER BY date DESC, id DESC LIMIT ? OFFSET ?",
        (*params, limit, offset),
    )
    return [dict(zip(TRANSACTION_COLUMNS, row)) for row in rows]


@app.get("/api/dashboard/summary")
def dashboard_summary(start_date: str | None = None, end_date: str | None = None):
    clauses, params = _date_clause(_iso_date(start_date, "start_date"), _iso_date(end_date, "end_date"))
    where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
    [(money_in, money_out, net, count)] = _query(
        "SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount END), 0), "
        "COALESCE(SUM(CASE WHEN amount < 0 THEN -amount END), 0), "
        f"COALESCE(SUM(amount), 0), COUNT(*) FROM transactions{where}",
        params,
    )
    return {"money_in": money_in, "money_out": money_out, "net": net, "transaction_count": count}


@app.get("/api/dashboard/categories")
def dashboard_categories(start_date: str | None = None, end_date: str | None = None):
    clauses, params = _date_clause(_iso_date(start_date, "start_date"), _iso_date(end_date, "end_date"))
    where = " AND ".join(["amount < 0", *clauses])
    rows = _query(
        f"SELECT category, SUM(-amount), COUNT(*) FROM transactions WHERE {where} "
        "GROUP BY category ORDER BY SUM(-amount) DESC, category",
        params,
    )
    return [{"category": category, "amount": amount, "transaction_count": count} for category, amount, count in rows]


# --------------------------------------------------------------------------
# History validation (read-only)
# --------------------------------------------------------------------------

class CoverageBody(BaseModel):
    import_ids: list[int]
    expected_start: str | None = None
    expected_end: str | None = None


@app.get("/api/history/integrity")
def history_integrity():
    return {"integrity": validate_import_integrity(_db()), "totals": validate_storage_totals(_db())}


@app.post("/api/history/coverage")
def history_coverage(body: CoverageBody):
    try:
        return validate_date_coverage(_db(), body.import_ids, expected_start=body.expected_start,
                                      expected_end=body.expected_end)
    except HistoryValidationError as exc:
        raise HTTPException(400, str(exc)) from None
