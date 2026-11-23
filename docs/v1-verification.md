# V1 verification

State of verification on 22 Nov 2026, branch `analysis-contract` (base commit
`c2889bc`, plus the uncommitted dashboard and release work).

**Summary.** All automated checks pass on the development Mac. A signed
release APK was built on EAS on 22 Nov 2026:
- build `a8fb40ab-66d3-4852-8b7d-2e6a6ffdacac`
- version 1.0.0, versionCode 2
- package `dev.expenses.tracker`
- signing SHA-1 `F4:04:2C:68:24:D9:F9:3A:ED:A7:EC:23:EE:71:AE:7F:72:9C:51:AD`

That build compiled the Kotlin authorization module for the first time.
Nothing has yet run on an Android device or against the real Google APIs.
Section 4 lists the device checks still to run.

## 1. Automated checks run

| Command | Result |
|---|---|
| `npm run check` (typecheck, lint, all tests) | exit 0; 26 suites; 428 passed, 5 skipped (the opt-in performance suite) |
| `npx expo export -p android` | exit 0; Hermes bundle 3.4 MB |
| `npx expo-doctor` | 20/20 checks passed |

Targeted groups, each run on its own with `npx jest <files>`:

| Area | Test files | Tests |
|---|---|---|
| Money parsing and aggregation | `domain/money`, `domain/analysis`, `db/spendingAnalysis`, `domain/spendingChart` | 98 passed |
| Calendar boundaries and leap years | `domain/dates`, `db/spendingAnalysis` | 85 passed |
| SQLite migrations | `db/migrations`, `db/repositories` | 36 passed |
| Submission states and restart recovery | `sync/submissions`, `domain/submissionPolicy` | 26 passed |
| Duplicate identity handling | `domain/ledger`, `sync/submissions`, `sync/refresh` (duplicate/ID tests only) | 7 passed |
| Refresh/submission races | `sync/refresh` | 20 passed |
| Form validation and dashboard states | `domain/expenseDraft`, `expenseForm`, `spending`, `spendingCharts`, `ui/*` | 61 passed |
| Reference fixture | `referenceFixture` | 6 passed |

These run against better-sqlite3 and an in-process fake of Drive and Sheets
(`test/fakeGoogle.ts`). The Kotlin authorization module is not exercised.

## 2. Reference fixture

The data source is [`test/fixtures/reference-ledger.tsv`](../test/fixtures/reference-ledger.tsv):

| Date | Category | Amount |
|---|---|---|
| 2025-12-31 | Transport | 5.00 |
| 2026-10-08 | Groceries | 42.50 |
| 2026-10-08 | Transport | 7.50 |
| 2026-10-09 | Groceries | 10.00 |
| 2026-11-01 | Bills | 20.00 |

`src/referenceFixture.test.tsx` loads it into the fake sheet, refreshes, and
checks two things:

- the analysis contract, for each of three cell forms:
  - as the app writes them;
  - as pasted into Sheets (date serials);
  - as plain text;
- the My spending screen.

| Expected | Contract | Screen |
|---|---|---|
| 8 October 2026 = 50.00 | 5,000 minor units | "$50.00" |
| October 2026 = 60.00 | 6,000 | "$60.00" |
| October Groceries = 52.50, 87.5 % | 5,250, 8,750 bp, 87.5 | "$52.50 · 87.5%" (bars and pie) |
| October Transport = 7.50, 12.5 % | 750, 1,250 bp, 12.5 | "$7.50 · 12.5%" |
| Year 2026 = 80.00 | 8,000 | "$80.00" |
| All time = 85.00 | 8,500 | "$85.00" |

The same test checks that switching between these periods makes no Sheets
requests after the first load. A separate test checks that opening the app
on Add expense never reads the ledger.

## 3. Performance

**Fixture.** `test/fixtures/largeLedger.ts`: 36,500 synthetic expenses, 10 a day
from 2016-11-25 to 2026-11-22, across 7 categories.

**Command.**
`PERF=1 PERF_OUT=perf.json npx jest src/performance.test.tsx --runInBand`

**Environment.**
- Apple M4 Pro (14 cores), 24 GB, macOS (Darwin 27.2.0), Node v22.23.2.
- better-sqlite3 behind the app's `SqlDatabase` interface.
- Fake Google with no network latency.

These numbers show relative cost and catch regressions. They are **not**
phone measurements.

| Measurement | Result |
|---|---|
| Rows in cache after refresh | 36,500 |
| Full refresh (read 19 chunks of 2,000 rows, validate, replace cache) | median 302 ms (3 runs); 24 requests |
| Period query: day / month / year | median 0–1 ms, max 1 ms (50 runs each) |
| Period query: all time | median 6 ms, max 6 ms |
| App start to ready Add expense form (36,500 rows cached) | 125 ms; 0 ledger reads |
| Open My spending (current month) | 78 ms |
| Switch to All time | 13 ms; 0 Sheets requests |

### UI stall found and fixed

Measurement showed that a refresh validated the whole sheet in one
synchronous pass. That held the JS thread for 106–112 ms on this machine, and
phones are typically several times slower.

Fixes:
- The refresh now validates in slices of 500 rows (`LEDGER_SLICE_ROWS`) and
  yields to the UI (`setTimeout 0`) between slices.
- The final duplicate check no longer allocates per row or re-sorts rows
  that are already in order. That step went from 16 ms to 1 ms.

The result is identical to the one-pass build. The tests in
`sync/refresh.test.ts` → "keeping the UI responsive on long sheets" check
this, with issues and duplicates that straddle slice boundaries.

| | Before | After |
|---|---|---|
| Longest JS block while validating 36,500 rows | 106–112 ms | 2 ms (73 slices, median 1 ms) |
| Full refresh duration | ~210 ms | ~302 ms (the pauses cost ~1 ms each in Node) |

Not yet measured on a device: the cost of each pause on Android, and refresh
time over real network latency.

## 4. Device and real-API checks: not yet run

Run these on a phone with a **dedicated test Google account**, so fixture
data never mixes with real expenses. Record the phone model, Android version,
build profile and the build's versionCode with each run.

| # | Check | Steps | Expected | Result |
|---|---|---|---|---|
| D1 | Authorization and spreadsheet creation | google-cloud-setup.md → Device acceptance checks 1–9 | As listed there | not run |
| D2 | Confirmed save | Add an expense for today | "Saved to Google Sheets"; the row appears in "My Expenses" with an Expense ID | not run |
| D3 | Backdated save | Add one dated last month | Row has that date; My spending → that month includes it | not run |
| D4 | Interrupted save, reconnection | Airplane mode → save → reopen the app → turn airplane mode off | Listed as "Saved on this phone, not yet in Google Sheets", then sent once; one row in the sheet | not run |
| D5 | App killed during a save | Save, then force-stop the app right away; reopen | Confirmed from the sheet or sent once; never two rows | not run |
| D6 | Correction and deletion | Change an amount in Sheets and delete another row → My spending → Refresh | Totals reflect both; the deleted row is gone | not run |
| D7 | Reference fixture | Paste `test/fixtures/reference-ledger.tsv` under the header of the test account's "My Expenses" → Refresh | The values in section 2 | not run |
| D8 | Restart | Force-stop and reopen while offline | Add expense opens at once; My spending shows saved results | not run |
| D9 | Reinstall recovery | Check nothing is waiting → uninstall → install the same APK → Connect | Same spreadsheet reused; Refresh restores all confirmed expenses | not run |
| D10 | Development signing | Development build: Connect Google | Connects (its SHA-1 is registered) | not run |
| D11 | Release signing and update | Install the release APK; then build again and install over it | Connects; the update installs without uninstalling; data kept | not run |
| D12 | Performance on device | Write the ledger with `PERF=1 PERF_TSV=large-ledger.tsv npx jest src/performance.test.tsx --runInBand`, import it into the test sheet (File → Import → Append), then time: cold start to the form, a period switch, a full Refresh | Form usable without waiting for Google; period switches feel instant; UI stays responsive during Refresh | not run |

## 5. Known limitations and unresolved defects

1. **Not verified on Android at all.** The Kotlin module in
   `modules/google-authorization` compiles (EAS build, 22 Nov 2026) but has
   never run, and no real Google API call has been made.
2. **Unverified assumption:** refresh detects edits made during a read by
   checking whether the Drive file's `version` or `modifiedTime` changed.
   That this changes on every cell edit needs confirming against real Google.
3. **Possible duplicate row:** a save whose request reaches Google after the
   settle window can create a second row with the same Expense ID. Refresh
   counts exact duplicates once.
4. Rows added by hand in Sheets need an Expense ID. Without one they are
   excluded from totals and listed with their row number.
5. My spending lists every row that needs fixing. A sheet with thousands of
   bad rows would render a very long list (not measured).
6. Uninstalling deletes unsent local saves (`allowBackup: false`).
   Confirmed expenses come back from the sheet.
7. Currency is AUD, provisional. The form offers a fixed list of 7
   categories.
8. Category colours cannot all be told apart pairwise with colour-vision
   deficiency, so every bar and slice also shows its name.
9. Display percentages are rounded to 0.1 % and add up to 100. The analysis
   contract keeps two decimals.
10. The Add expense date picker still uses the date-picker library's
    deprecated `onChange` callback; it shows a warning in development
    builds.
11. Android only. The Google module has no iOS implementation.
