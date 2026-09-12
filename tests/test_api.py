"""Step 15 tests for the FastAPI layer. Synthetic data, temporary databases, fake parsers.

The invalid-PDF test deliberately uses the real parsers with junk bytes.
"""

import hashlib
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import api
import pdf_intake

REPO = Path(__file__).resolve().parent.parent
PDF_BYTES = b"%PDF-1.4 synthetic statement bytes"
ROWS = [("EXAMPLE CAFE MELBOURNE", -450), ("Transfer to xx0000 own savings", -5000), ("SALARY EXAMPLE PTY", 250000)]


def statement(rows, start="2026-01-01", end="2026-01-31"):
    running = 10000
    out = []
    for description, amount in rows:
        running += amount
        out.append({"date": "2026-01-05", "description": description, "amount": amount, "balance": running})
    return {"statement_start_date": start, "statement_end_date": end, "opening_balance": 10000,
            "closing_balance": running, "transactions": out}


class ApiTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)
        self.uploads = self.dir / "uploads"
        self.uploads.mkdir()
        self.db_path = self.dir / "api.db"
        for name, value in (("DB_PATH", self.db_path), ("UPLOAD_DIR", str(self.uploads))):
            patcher = patch.object(api, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        api.PREPARED.clear()
        self.addCleanup(api.PREPARED.clear)
        self.calls = []
        self.fakes = {
            "commbank": lambda p: self.calls.append(("commbank", Path(p))) or statement(ROWS),
            "ing": lambda p: self.calls.append(("ing", Path(p))) or statement(ROWS[:1], "2026-02-01", "2026-02-28"),
        }
        self.client = TestClient(api.app)
        self.client.__enter__()  # runs lifespan -> init_db on the temp DB
        self.addCleanup(self.client.__exit__, None, None, None)
        self.conn = sqlite3.connect(self.db_path)
        self.addCleanup(self.conn.close)

    def with_fakes(self):
        patcher = patch.dict(pdf_intake.PARSERS, self.fakes)
        patcher.start()
        self.addCleanup(patcher.stop)

    def prepare(self, bank="commbank", data=PDF_BYTES, filename="statement.pdf"):
        return self.client.post("/api/imports/prepare", data={"bank": bank}, files={"file": (filename, data, "application/pdf")})

    def seed_category(self, name="Eating Out", active=1):
        self.conn.execute("INSERT INTO categories (name, active) VALUES (?, ?)", (name, active))
        self.conn.commit()

    def seed_transaction(self, date, amount, *, bank="commbank", category=None, description="SYNTHETIC"):
        self._n = getattr(self, "_n", 0) + 1
        self.conn.execute(
            "INSERT INTO transactions (bank, date, raw_description, amount, balance, category, transaction_hash) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)", (bank, date, description, amount, 0, category, f"{self._n:064x}"))
        self.conn.commit()

    def counts(self):
        return {t: self.conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                for t in ("transactions", "rules", "imports", "categories")}


class HealthAndSafetyTests(ApiTestCase):
    def test_health(self):
        response = self.client.get("/api/health")
        self.assertEqual((response.status_code, response.json()), (200, {"status": "ok"}))

    def test_cors_is_explicit_not_wildcard(self):
        self.assertNotIn("*", api.ALLOWED_ORIGINS)
        allowed = self.client.options("/api/health", headers={"Origin": "http://localhost:5173",
                                                               "Access-Control-Request-Method": "GET"})
        self.assertEqual(allowed.headers.get("access-control-allow-origin"), "http://localhost:5173")
        denied = self.client.options("/api/health", headers={"Origin": "http://evil.example",
                                                              "Access-Control-Request-Method": "GET"})
        self.assertIsNone(denied.headers.get("access-control-allow-origin"))

    def test_default_upload_dir_is_system_temp_outside_repo(self):
        self.assertIsNone(api.__dict__.get("_ORIGINAL_UPLOAD_DIR", None))
        system_tmp = Path(tempfile.gettempdir()).resolve()
        self.assertFalse(system_tmp.is_relative_to(REPO))

    def test_unexpected_exception_is_a_server_error_not_400(self):
        self.with_fakes()
        client = TestClient(api.app, raise_server_exceptions=False)
        with patch("api.prepare_import", side_effect=RuntimeError("boom")):
            response = client.post("/api/imports/prepare", data={"bank": "commbank"},
                                   files={"file": ("s.pdf", PDF_BYTES, "application/pdf")})
        self.assertEqual(response.status_code, 500)
        self.assertNotIn("boom", response.text)
        self.assertNotIn("Traceback", response.text)
        self.assertEqual(list(self.uploads.iterdir()), [])  # temp upload still removed

    def test_parser_files_untouched_and_no_dumps_written(self):
        before = {p: p.read_bytes() for p in (REPO / "commbank_parser.py", REPO / "ing_parser.py")}
        repo_files_before = sorted(p for p in REPO.rglob("*") if p.is_file() and ".git" not in p.parts
                                   and "__pycache__" not in p.parts and ".pytest_cache" not in p.parts)
        self.with_fakes()
        token = self.prepare().json()["import_token"]
        self.client.get("/api/transactions")
        self.client.delete(f"/api/imports/{token}")
        self.assertEqual({p: p.read_bytes() for p in before}, before)
        repo_files_after = sorted(p for p in REPO.rglob("*") if p.is_file() and ".git" not in p.parts
                                  and "__pycache__" not in p.parts and ".pytest_cache" not in p.parts)
        self.assertEqual(repo_files_after, repo_files_before)
        self.assertEqual(sorted(p.name for p in self.dir.iterdir()), ["api.db", "uploads"])
        self.assertEqual(list(self.uploads.iterdir()), [])


class PrepareTests(ApiTestCase):
    def test_routes_by_bank_and_returns_token_and_items(self):
        self.with_fakes()
        cba = self.prepare("CommBank")
        ing = self.prepare("ing", filename="ing statement.pdf")
        self.assertEqual((cba.status_code, ing.status_code), (200, 200))
        self.assertEqual([c[0] for c in self.calls], ["commbank", "ing"])
        body = cba.json()
        self.assertEqual(set(body), {"import_token", "bank", "statement_start_date", "statement_end_date",
                                     "parsed_count", "review_items"})
        self.assertNotIn("file_hash", body)
        self.assertEqual((body["bank"], body["parsed_count"], len(body["review_items"])), ("commbank", 3, 3))
        self.assertEqual(ing.json()["parsed_count"], 1)
        self.assertNotEqual(body["import_token"], ing.json()["import_token"])
        # token maps to server-held prepared state, with the upload's own filename
        prepared = api.PREPARED[body["import_token"]]
        self.assertEqual(prepared["original_filename"], "statement.pdf")
        self.assertEqual(prepared["file_hash"], hashlib.sha256(PDF_BYTES).hexdigest())
        self.assertEqual(self.counts(), {"transactions": 0, "rules": 0, "imports": 0, "categories": 0})

    def test_unsupported_bank_and_missing_file(self):
        self.with_fakes()
        self.assertEqual(self.prepare("westpac").status_code, 400)
        response = self.client.post("/api/imports/prepare", data={"bank": "commbank"})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.calls, [])
        self.assertEqual(api.PREPARED, {})

    def test_invalid_pdf_bytes_clean_400(self):
        response = self.prepare("commbank", data=b"hello, not a pdf")  # real parser path
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"], "Invalid PDF")
        self.assertEqual(list(self.uploads.iterdir()), [])

    def test_empty_and_wrong_extension_uploads_give_generic_errors(self):
        self.with_fakes()
        real_tempfile = tempfile.NamedTemporaryFile
        temp_names = []

        def recording(*args, **kwargs):
            handle = real_tempfile(*args, **kwargs)
            temp_names.append(Path(handle.name).name)
            return handle

        with patch("api.tempfile.NamedTemporaryFile", side_effect=recording):
            responses = [self.prepare(data=b""), self.prepare(filename="statement.txt")]
        self.assertEqual(len(temp_names), 2)
        for response in responses:
            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.json(), {"detail": "Invalid PDF upload"})
            for forbidden in ("/tmp", "/private", "/Users", "Traceback", *temp_names):
                self.assertNotIn(forbidden, response.text)
        self.assertEqual(self.calls, [])
        self.assertEqual(list(self.uploads.iterdir()), [])
        # bank validation happens before any temp file exists and keeps its own clean message
        self.assertIn("unsupported bank", self.prepare("westpac").json()["detail"])

    def test_temporary_upload_removed_on_success_and_failure(self):
        from commbank_parser import CommBankParseError
        self.with_fakes()
        self.assertEqual(self.prepare().status_code, 200)                         # success
        self.assertEqual(list(self.uploads.iterdir()), [])
        with patch.dict(pdf_intake.PARSERS, {"commbank": lambda p: (_ for _ in ()).throw(CommBankParseError("x"))}):
            self.assertEqual(self.prepare(data=b"other bytes").status_code, 400)  # parser failure
        self.assertEqual(list(self.uploads.iterdir()), [])
        token = self.prepare(data=b"third bytes").json()["import_token"]
        items = [{**i, "decision": "approved"} for i in api.PREPARED[token]["review_items"]]
        self.client.post(f"/api/imports/{token}/finalize", json={"review_items": items})
        self.assertEqual(self.prepare(data=b"third bytes").status_code, 409)     # duplicate
        self.assertEqual(list(self.uploads.iterdir()), [])
        self.assertTrue(all(c[1].parent == self.uploads and c[1].name != "statement.pdf" for c in self.calls))

    def test_duplicate_pdf_is_409(self):
        self.with_fakes()
        token = self.prepare().json()["import_token"]
        items = [{**i, "decision": "approved"} for i in api.PREPARED[token]["review_items"]]
        self.assertEqual(self.client.post(f"/api/imports/{token}/finalize", json={"review_items": items}).status_code, 200)
        again = self.prepare(filename="renamed.pdf")
        self.assertEqual(again.status_code, 409)
        self.assertEqual(len(self.calls), 1)  # not reparsed


class FinalizeTests(ApiTestCase):
    def setUp(self):
        super().setUp()
        self.with_fakes()
        self.seed_category("Eating Out")
        self.token = self.prepare().json()["import_token"]
        self.items = api.PREPARED[self.token]["review_items"]

    def test_finalize_valid_token_removes_token_and_persists(self):
        reviewed = [{**self.items[0], "decision": "approved", "category": "Eating Out", "remember_choice": True},
                    {**self.items[1], "decision": "rejected"},
                    {**self.items[2], "decision": "approved"}]
        response = self.client.post(f"/api/imports/{self.token}/finalize", json={"review_items": reviewed})
        self.assertEqual(response.status_code, 200)
        summary = response.json()
        self.assertEqual((summary["status"], summary["saved_count"], summary["rejected_count"], summary["rules_created"]),
                         ("completed", 2, 1, 1))
        self.assertNotIn(self.token, api.PREPARED)
        self.assertEqual(self.counts(), {"transactions": 2, "rules": 1, "imports": 1, "categories": 1})
        self.assertEqual(self.conn.execute("SELECT original_filename FROM imports").fetchone()[0], "statement.pdf")
        self.assertEqual(self.client.post(f"/api/imports/{self.token}/finalize", json={"review_items": reviewed}).status_code, 404)

    def test_failed_finalize_keeps_token_and_writes_nothing(self):
        tampered = [{**i, "decision": "approved"} for i in self.items]
        tampered[0]["amount"] = -1
        response = self.client.post(f"/api/imports/{self.token}/finalize", json={"review_items": tampered})
        self.assertEqual(response.status_code, 400)
        self.assertIn(self.token, api.PREPARED)
        self.assertEqual(self.counts()["imports"], 0)
        bad_category = [{**i, "decision": "approved", "category": "Nope"} for i in self.items]
        self.assertEqual(self.client.post(f"/api/imports/{self.token}/finalize", json={"review_items": bad_category}).status_code, 400)
        self.assertIn(self.token, api.PREPARED)

    def test_caller_supplied_prepared_state_is_rejected(self):
        before = self.counts()
        forged = self.client.post(f"/api/imports/{self.token}/finalize",
                                  json={"prepared": {"bank": "ing"},
                                        "review_items": [{**i, "decision": "approved"} for i in self.items]})
        self.assertEqual(forged.status_code, 422)
        self.assertIn(self.token, api.PREPARED)
        self.assertEqual(self.counts(), before)
        self.assertEqual(self.counts()["imports"], 0)

    def test_rule_conflict_is_409_and_keeps_token(self):
        self.conn.execute("INSERT INTO rules (pattern, merchant, category) VALUES (?, 'Other', 'Eating Out')",
                          (self.items[0]["description"],))
        self.conn.commit()
        reviewed = [{**i, "decision": "approved"} for i in self.items]
        reviewed[0].update(category="Eating Out", merchant="Example Cafe", remember_choice=True)
        response = self.client.post(f"/api/imports/{self.token}/finalize", json={"review_items": reviewed})
        self.assertEqual(response.status_code, 409)
        self.assertIn(self.token, api.PREPARED)
        self.assertEqual(self.counts()["transactions"], 0)

    def test_unknown_token_and_discard(self):
        self.assertEqual(self.client.post("/api/imports/nope/finalize", json={"review_items": []}).status_code, 404)
        self.assertEqual(self.client.delete("/api/imports/nope").status_code, 404)
        self.assertEqual(self.client.delete(f"/api/imports/{self.token}").json(), {"status": "discarded"})
        self.assertNotIn(self.token, api.PREPARED)
        self.assertEqual(self.client.delete(f"/api/imports/{self.token}").status_code, 404)
        self.assertEqual(self.counts()["imports"], 0)


class CategoryAndRuleTests(ApiTestCase):
    def test_categories_crud(self):
        self.assertEqual(self.client.get("/api/categories").json(), [])
        created = self.client.post("/api/categories", json={"name": "  Travel "})
        self.assertEqual((created.status_code, created.json()["name"], created.json()["active"]), (201, "Travel", True))
        self.assertEqual(self.client.post("/api/categories", json={"name": "travel"}).status_code, 409)
        self.assertEqual(self.client.post("/api/categories", json={"name": "   "}).status_code, 400)
        self.assertEqual(self.client.patch("/api/categories/TRAVEL/deactivate").json()["active"], False)
        self.assertEqual([c["name"] for c in self.client.get("/api/categories").json()], [])
        self.assertEqual([c["name"] for c in self.client.get("/api/categories?include_inactive=true").json()], ["Travel"])
        self.assertEqual(self.client.patch("/api/categories/travel/activate").json()["active"], True)
        self.assertEqual(self.client.patch("/api/categories/Gym/activate").status_code, 404)

    def test_rules_list_and_toggle(self):
        self.seed_category("Eating Out")
        self.conn.execute("INSERT INTO rules (pattern, merchant, category) VALUES (?, 'Example Cafe', 'Eating Out')",
                          ("CARD Example Cafe/MELBOURNE xx0000",))
        self.conn.commit()
        listed = self.client.get("/api/rules").json()
        self.assertEqual([r["pattern"] for r in listed], ["CARD Example Cafe/MELBOURNE xx0000"])
        self.assertEqual(self.client.patch("/api/rules/card example cafe%2Fmelbourne xx0000/deactivate").json()["active"], False)
        self.assertEqual(self.client.get("/api/rules").json(), [])
        self.assertEqual(len(self.client.get("/api/rules?include_inactive=true").json()), 1)
        self.assertEqual(self.client.patch("/api/rules/CARD Example Cafe/MELBOURNE xx0000/activate").json()["active"], True)
        self.assertEqual(self.client.patch("/api/rules/no such pattern/activate").status_code, 404)


class TransactionTests(ApiTestCase):
    def setUp(self):
        super().setUp()
        self.seed_transaction("2026-01-05", -1200, category="Groceries")
        self.seed_transaction("2026-01-05", 250000, bank="ing")
        self.seed_transaction("2026-02-10", -450, category="Eating Out")
        self.seed_transaction("2026-03-01", 3000, category="Groceries")  # refund: positive, categorised
        self.seed_transaction("2026-03-15", -999)                        # uncategorised spend

    def test_list_default_order_and_shape(self):
        rows = self.client.get("/api/transactions").json()
        self.assertEqual([(r["date"], r["id"]) for r in rows],
                         [("2026-03-15", 5), ("2026-03-01", 4), ("2026-02-10", 3), ("2026-01-05", 2), ("2026-01-05", 1)])
        self.assertEqual(set(rows[0]), {"id", "bank", "date", "raw_description", "merchant", "amount", "balance",
                                        "type", "category", "subcategory", "created_at"})
        self.assertTrue(all(isinstance(r["amount"], int) and isinstance(r["balance"], int) for r in rows))
        self.assertIn('"amount":-999', self.client.get("/api/transactions?limit=1").text)  # no float in JSON

    def test_filters_limit_offset(self):
        self.assertEqual([r["id"] for r in self.client.get("/api/transactions?bank=ING").json()], [2])
        self.assertEqual([r["id"] for r in self.client.get("/api/transactions?start_date=2026-02-01&end_date=2026-03-01").json()], [4, 3])
        self.assertEqual([r["id"] for r in self.client.get("/api/transactions?category=Groceries").json()], [4, 1])
        self.assertEqual([r["id"] for r in self.client.get("/api/transactions?limit=2&offset=1").json()], [4, 3])
        self.assertEqual(self.client.get("/api/transactions?bank=westpac").status_code, 400)
        self.assertEqual(self.client.get("/api/transactions?start_date=01/02/2026").status_code, 400)
        self.assertEqual(self.client.get("/api/transactions?limit=0").status_code, 422)
        self.assertEqual(self.client.get("/api/transactions?limit=5000").status_code, 422)

    def test_dashboard_summary(self):
        summary = self.client.get("/api/dashboard/summary").json()
        self.assertEqual(summary, {"money_in": 253000, "money_out": 2649, "net": 250351, "transaction_count": 5})
        filtered = self.client.get("/api/dashboard/summary?start_date=2026-02-01&end_date=2026-03-31").json()
        self.assertEqual(filtered, {"money_in": 3000, "money_out": 1449, "net": 1551, "transaction_count": 3})
        empty = self.client.get("/api/dashboard/summary?start_date=2030-01-01&end_date=2030-12-31").json()
        self.assertEqual(empty, {"money_in": 0, "money_out": 0, "net": 0, "transaction_count": 0})

    def test_dashboard_categories(self):
        breakdown = self.client.get("/api/dashboard/categories").json()
        self.assertEqual(breakdown, [{"category": "Groceries", "amount": 1200, "transaction_count": 1},
                                     {"category": None, "amount": 999, "transaction_count": 1},
                                     {"category": "Eating Out", "amount": 450, "transaction_count": 1}])
        self.assertTrue(all(isinstance(b["amount"], int) for b in breakdown))
        filtered = self.client.get("/api/dashboard/categories?start_date=2026-02-01&end_date=2026-02-28").json()
        self.assertEqual(filtered, [{"category": "Eating Out", "amount": 450, "transaction_count": 1}])


class HistoryTests(ApiTestCase):
    def test_integrity_totals_and_coverage(self):
        self.conn.execute("INSERT INTO imports (bank, original_filename, file_hash, statement_start_date, "
                          "statement_end_date, status, parsed_count, approved_count) VALUES "
                          "('ing', 'a.pdf', ?, '2026-01-01', '2026-01-31', 'completed', 5, 1)", ("a" * 64,))
        self.conn.execute("INSERT INTO imports (bank, original_filename, file_hash, statement_start_date, "
                          "statement_end_date, status, parsed_count, approved_count) VALUES "
                          "('ing', 'b.pdf', ?, '2026-03-01', '2026-03-31', 'completed', 5, 0)", ("b" * 64,))
        self.conn.commit()
        self.seed_transaction("2026-01-05", -1)
        result = self.client.get("/api/history/integrity").json()
        self.assertEqual(result["integrity"], {"completed_import_count": 2, "problems": [], "valid": True})
        self.assertEqual(result["totals"], {"completed_import_count": 2, "sum_approved_count": 1,
                                            "stored_transaction_count": 1, "matches": True})
        coverage = self.client.post("/api/history/coverage", json={"import_ids": [1, 2]}).json()
        self.assertEqual((coverage["gaps"], coverage["covered_days"]), ([{"start": "2026-02-01", "end": "2026-02-28"}], 62))
        complete = self.client.post("/api/history/coverage", json={"import_ids": [1, 2], "expected_start": "2026-01-01",
                                                                    "expected_end": "2026-03-31"}).json()
        self.assertFalse(complete["expected_period_complete"])
        self.assertEqual(self.client.post("/api/history/coverage", json={"import_ids": []}).status_code, 400)
        self.assertEqual(self.client.post("/api/history/coverage", json={"import_ids": [1, 99]}).status_code, 400)
        self.assertEqual(self.client.post("/api/history/coverage", json={"import_ids": [1], "expected_start": "2026-01-01"}).status_code, 400)
        self.assertEqual(self.client.post("/api/history/coverage", json={"import_ids": ["x"]}).status_code, 422)


if __name__ == "__main__":
    unittest.main()
