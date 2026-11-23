import { FakeAuthorizer, FakeGoogle } from '../../test/fakeGoogle';
import { openTestDatabase, type TestDatabase } from '../../test/sqliteTestDatabase';

import { getAppSettings } from '@/db/appSettings';
import { listConfirmedExpenses } from '@/db/confirmedExpenses';
import { listSheetIssues } from '@/db/ledgerCache';
import { migrateDatabase } from '@/db/migrations';
import { listPendingSubmissions } from '@/db/pendingSubmissions';
import { analyzeSpending } from '@/db/spendingAnalysis';
import { parseLocalDate, type LocalDate } from '@/domain/dates';
import { buildLedger } from '@/domain/ledger';
import type { DataScope } from '@/domain/expense';

import { connectGoogle } from './connection';
import { MAX_REFRESH_ATTEMPTS, validateInSlices } from './refresh';
import { SubmissionEngine, type SubmissionDeps } from './submissions';

const ALICE = 'sub-alice';
const T0 = Date.parse('2026-11-22T03:00:00Z');
const CHUNK = 250;

let google: FakeGoogle;
let authorizer: FakeAuthorizer;
let device: TestDatabase;
let scope: DataScope;
let online: boolean;
let engine: SubmissionEngine;

const date = (value: string) => parseLocalDate(value) as LocalDate;
const all = { kind: 'all' } as const;

function deps(overrides: Partial<SubmissionDeps> = {}): SubmissionDeps {
  let ids = 0;
  return {
    db: device.db,
    authorizer,
    fetch: google.fetch,
    isOnline: async () => online,
    newId: () => `local-${(ids += 1)}`,
    now: () => T0,
    refreshChunkRows: CHUNK,
    ...overrides,
  };
}

function seed(...rows: unknown[][]) {
  google.userEdit(scope.spreadsheetId, (sheet) => {
    sheet.push(...rows);
  });
}

const valueReads = () => google.requests('GET', '/values/').filter((r) => !r.path.includes('A1%3AE2'));
const confirmed = () => listConfirmedExpenses(device.db, scope, null);

beforeEach(async () => {
  google = new FakeGoogle();
  google.addAccount(ALICE, 'alice@example.com');
  authorizer = new FakeAuthorizer(google, [ALICE]);
  device = openTestDatabase();
  await migrateDatabase(device.db);
  const state = await connectGoogle({ db: device.db, authorizer, fetch: google.fetch }, { interactive: true });
  if (state.kind !== 'ready') throw new Error('setup failed');
  scope = { accountId: ALICE, spreadsheetId: state.spreadsheetId };
  online = true;
  engine = new SubmissionEngine(deps());
  seed(
    ['2026-11-01', 'Rent share', 500, 'Bills', 'e1'],
    ['2026-11-15', 'Groceries run', 82.4, 'Groceries', 'e2'],
    ['2026-10-31', 'Bus', 3.8, 'Transport', 'e3'],
  );
  google.log.length = 0;
});

afterEach(() => {
  device.close();
});

describe('loading remote records', () => {
  test('a first refresh fills the empty cache and records the refresh time', async () => {
    expect(await confirmed()).toEqual([]);

    expect(await engine.refresh()).toMatchObject({ kind: 'refreshed', expenseCount: 3, excludedRowCount: 0 });

    expect((await confirmed()).map((e) => e.expenseId)).toEqual(['e3', 'e1', 'e2']);
    expect((await getAppSettings(device.db)).lastSuccessfulSyncAt).toBe(new Date(T0).toISOString());
    expect(engine.getSyncStatus()).toEqual({ kind: 'idle' });
  });

  test('reads only columns A–E in bounded requests', async () => {
    await engine.refresh();
    const ranges = valueReads().map((r) => decodeURIComponent(r.path.split('/values/')[1] ?? ''));
    expect(ranges).toEqual([
      "'Expenses'!A2:E251",
      "'Expenses'!A252:E501",
      "'Expenses'!A502:E751",
      "'Expenses'!A752:E1000",
    ]);
  });
});

describe('reconciling remote changes', () => {
  beforeEach(async () => {
    await engine.refresh();
  });

  test('corrected values in Google Sheets appear after refresh', async () => {
    google.userEdit(scope.spreadsheetId, (rows) => {
      rows[2] = ['2026-11-16', 'Groceries (corrected)', 28.4, 'Shopping', 'e2'];
    });

    await engine.refresh();

    expect((await confirmed()).find((e) => e.expenseId === 'e2')).toEqual({
      expenseId: 'e2',
      purchaseDate: '2026-11-16',
      description: 'Groceries (corrected)',
      amountMinor: 2_840,
      category: 'Shopping',
    });
  });

  test('deleted rows disappear and added rows appear', async () => {
    google.userEdit(scope.spreadsheetId, (rows) => {
      rows.splice(1, 1); // delete e1
      rows.push(['2026-11-20', 'Pharmacy', 12, 'Health', 'manual-1']);
    });

    await engine.refresh();

    expect((await confirmed()).map((e) => e.expenseId)).toEqual(['e3', 'e2', 'manual-1']);
    expect((await analyzeSpending(device.db, scope, { kind: 'month', year: 2026, month: 11 })).totalMinor).toBe(8_240 + 1_200);
  });
});

describe('failed refreshes keep the previous cache', () => {
  beforeEach(async () => {
    await engine.refresh();
    google.log.length = 0;
  });

  async function snapshot() {
    return {
      expenses: await confirmed(),
      issues: await listSheetIssues(device.db, scope),
      lastSync: (await getAppSettings(device.db)).lastSuccessfulSyncAt,
    };
  }

  test('a network failure part-way through the read changes nothing', async () => {
    const before = await snapshot();
    google.userEdit(scope.spreadsheetId, (rows) => rows.splice(1, 2));
    google.failNext({ method: 'GET', pathIncludes: 'A252', response: 'network' });

    expect(await new SubmissionEngine(deps({ now: () => T0 + 60_000 })).refresh()).toEqual({ kind: 'failed', code: 'offline' });
    expect(await snapshot()).toEqual(before);
  });

  test('a failure while writing the new cache rolls back to the previous cache', async () => {
    const before = await snapshot();
    google.userEdit(scope.spreadsheetId, (rows) => rows.splice(1, 1));
    let runsInTransaction = 0;
    const failing: SubmissionDeps['db'] = {
      ...device.db,
      transaction: (task) =>
        device.db.transaction((tx) =>
          task({
            ...tx,
            run: (sql, params) => {
              runsInTransaction += 1;
              if (runsInTransaction === 3) return Promise.reject(new Error('disk full'));
              return tx.run(sql, params);
            },
          }),
        ),
    };

    expect(await new SubmissionEngine(deps({ db: failing })).refresh()).toEqual({ kind: 'failed', code: 'server_error' });
    expect(await snapshot()).toEqual(before);
  });

  test('a changed header row fails validation and changes nothing', async () => {
    const before = await snapshot();
    google.userEdit(scope.spreadsheetId, (rows) => {
      rows[0] = ['Date', 'Amount', 'Description', 'Category', 'Expense ID'];
      rows.splice(1, 3);
    });

    expect(await engine.refresh()).toEqual({ kind: 'failed', code: 'sheet_structure_changed' });
    expect(engine.getSyncStatus()).toEqual({ kind: 'failed', code: 'sheet_structure_changed' });
    expect(await snapshot()).toEqual(before);
  });

  test('offline: no request is made and cached results still answer queries', async () => {
    online = false;
    const before = await snapshot();

    expect(await engine.refresh()).toEqual({ kind: 'failed', code: 'offline' });
    const analysis = await analyzeSpending(device.db, scope, { kind: 'month', year: 2026, month: 11 });

    expect(google.log).toHaveLength(0);
    expect(analysis.totalMinor).toBe(58_240);
    expect(await snapshot()).toEqual(before);
  });
});

describe('changes during a multi-request refresh', () => {
  test('an edit between chunk requests restarts the read, and the result includes it', async () => {
    let edited = false;
    google.beforeRequest = (request) => {
      if (!edited && request.method === 'GET' && request.path.includes('A252')) {
        edited = true;
        google.userEdit(scope.spreadsheetId, (rows) => {
          rows[1] = ['2026-11-01', 'Rent share', 450, 'Bills', 'e1'];
        });
      }
    };

    expect(await engine.refresh()).toMatchObject({ kind: 'refreshed' });
    expect((await confirmed()).find((e) => e.expenseId === 'e1')?.amountMinor).toBe(45_000);
    expect(valueReads().length).toBe(8); // two complete passes of 4 chunks
  });

  test('a sheet that keeps changing fails after the attempt limit and keeps the cache', async () => {
    await engine.refresh();
    const before = await confirmed();
    google.beforeRequest = (request) => {
      if (request.method === 'GET' && request.path.includes('A252')) {
        google.userEdit(scope.spreadsheetId, (rows) => rows.push(['2026-11-21', 'x', 1, 'Other', `churn-${rows.length}`]));
      }
    };

    expect(await engine.refresh()).toEqual({ kind: 'failed', code: 'changed_during_refresh' });
    expect(google.requests('GET', 'A252')).toHaveLength(1 + MAX_REFRESH_ATTEMPTS);
    expect(await confirmed()).toEqual(before);
  });
});

describe('coordination with submissions', () => {
  const lunch = { purchaseDate: date('2026-11-22'), description: 'Lunch', amountMinor: 1_650, category: 'Eating out' };

  test('a submission made while a refresh runs survives it', async () => {
    const [refreshed, saved] = await Promise.all([engine.refresh(), engine.submit(lunch)]);

    expect(refreshed.kind).toBe('refreshed');
    expect(saved).toEqual({ kind: 'confirmed', submissionId: 'local-1' });
    expect((await confirmed()).map((e) => e.expenseId).sort()).toEqual(['e1', 'e2', 'e3', 'local-1']);
  });

  test('a submission confirmed just before a refresh also survives it', async () => {
    const saving = engine.submit(lunch);
    const refreshing = engine.refresh();
    await Promise.all([saving, refreshing]);

    expect((await confirmed()).map((e) => e.expenseId).sort()).toEqual(['e1', 'e2', 'e3', 'local-1']);
  });

  test('an older refresh cannot erase a record confirmed after its final read', async () => {
    // Pause the refresh right after its last read (the closing version check)
    // and give a save the chance to confirm before the refresh commits.
    let driveGets = 0;
    let saving: Promise<unknown> | null = null;
    const gated: SubmissionDeps['fetch'] = async (url, init) => {
      const response = await google.fetch(url, init);
      if (init.method === 'GET' && url.includes('/drive/v3/files/') && saving === null) {
        driveGets += 1;
        if (driveGets === 2) {
          // The version check has already been answered (unchanged); now a save runs.
          saving = engine.submit(lunch);
          await Promise.race([saving, new Promise((resolve) => setTimeout(resolve, 50))]);
        }
      }
      return response;
    };
    engine = new SubmissionEngine(deps({ fetch: gated }));

    await engine.refresh();
    await saving;

    expect((await confirmed()).map((e) => e.expenseId).sort()).toEqual(['e1', 'e2', 'e3', 'local-1']);
  });

  test('refresh completes a submission whose row is already in the sheet', async () => {
    google.failNext({ method: 'POST', pathIncludes: ':append', response: 'network_after_commit' });
    expect(await engine.submit(lunch)).toMatchObject({ kind: 'unresolved', state: 'uncertain' });

    await engine.refresh();

    expect(await listPendingSubmissions(device.db, scope)).toEqual([]);
    expect((await confirmed()).map((e) => e.expenseId)).toContain('local-1');
  });

  test('a pending submission not yet in the sheet stays pending and out of the totals', async () => {
    online = false;
    await engine.submit(lunch);
    online = true;
    google.failNext({ method: 'POST', pathIncludes: ':append', response: { status: 503 } });

    await engine.refresh();

    expect((await listPendingSubmissions(device.db, scope)).map((p) => p.submissionId)).toEqual(['local-1']);
    expect((await analyzeSpending(device.db, scope, all)).totalMinor).toBe(50_000 + 8_240 + 380);
  });
});

describe('data validation', () => {
  test('problem rows are excluded with row references; exact duplicates count once; conflicts never count', async () => {
    seed(
      ['', '', '', '', ''], // row 5: empty
      ['2026-11-02', 'Typo amount', 'abc', 'Other', 'bad-amount'], // row 6
      ['2026-02-30', 'Bad date', 5, 'Other', 'bad-date'], // row 7
      ['2026-11-03', 'No id', 5, 'Other', ''], // row 8
      ['2026-11-04', 'No category', 5, '', 'no-cat'], // row 9
      ['2026-11-15', 'Groceries run', 82.4, 'Groceries', 'e2'], // row 10: exact duplicate of row 3
      ['2026-11-05', 'Dinner', 40, 'Eating out', 'clash'], // row 11
      ['2026-11-05', 'Dinner', 44, 'Eating out', 'clash'], // row 12: conflicts with row 11
      ['2026-11-06', 'Negative', -2, 'Other', 'neg'], // row 13
    );

    expect(await engine.refresh()).toMatchObject({ kind: 'refreshed', expenseCount: 3, excludedRowCount: 7 });

    expect(await listSheetIssues(device.db, scope)).toEqual([
      { rowNumber: 6, kind: 'invalid_amount', expenseId: 'bad-amount' },
      { rowNumber: 7, kind: 'invalid_date', expenseId: 'bad-date' },
      { rowNumber: 8, kind: 'missing_id', expenseId: null },
      { rowNumber: 9, kind: 'missing_category', expenseId: 'no-cat' },
      { rowNumber: 10, kind: 'duplicate_resolved', expenseId: 'e2' },
      { rowNumber: 11, kind: 'conflicting_duplicate', expenseId: 'clash' },
      { rowNumber: 12, kind: 'conflicting_duplicate', expenseId: 'clash' },
      { rowNumber: 13, kind: 'invalid_amount', expenseId: 'neg' },
    ]);
    const analysis = await analyzeSpending(device.db, scope, all);
    expect(analysis.totalMinor).toBe(50_000 + 8_240 + 380);
    expect(analysis.excludedRowCount).toBe(7);
  });

  test('fixing the rows in the sheet clears the issues on the next refresh', async () => {
    seed(['2026-11-02', 'Typo amount', 'abc', 'Other', 'fix-me']);
    await engine.refresh();
    google.userEdit(scope.spreadsheetId, (rows) => {
      rows[4] = ['2026-11-02', 'Typo amount', 7.5, 'Other', 'fix-me'];
    });

    await engine.refresh();

    expect(await listSheetIssues(device.db, scope)).toEqual([]);
    expect((await analyzeSpending(device.db, scope, all)).excludedRowCount).toBe(0);
  });
});

test('changing periods queries SQLite only', async () => {
  await engine.refresh();
  google.log.length = 0;
  online = false;

  const periods = [
    { kind: 'day', date: date('2026-11-15') },
    { kind: 'month', year: 2026, month: 10 },
    { kind: 'month', year: 2026, month: 11 },
    { kind: 'year', year: 2026 },
    all,
  ] as const;
  const totals = [];
  for (const period of periods) totals.push((await analyzeSpending(device.db, scope, period)).totalMinor);

  expect(totals).toEqual([8_240, 380, 58_240, 58_620, 58_620]);
  expect(google.log).toHaveLength(0);
});

describe('keeping the UI responsive on long sheets', () => {
  function sheetRows(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      rowNumber: index + 2,
      cells: [`2026-10-${String((index % 28) + 1).padStart(2, '0')}`, `Item ${index}`, (index % 50) + 1, 'Groceries', `id-${index}`],
    }));
  }

  test('validation in slices gives exactly the one-pass result, pausing between slices', async () => {
    const rows = sheetRows(1_250);
    // Issues and duplicates that straddle slice boundaries.
    rows[499] = { rowNumber: 501, cells: ['2026-10-01', 'Same', 5, 'Bills', 'dup'] };
    rows[500] = { rowNumber: 502, cells: ['not a date', 'Bad', 5, 'Bills', 'bad-date'] };
    rows[1_100] = { rowNumber: 1_102, cells: ['2026-10-01', 'Same', 5, 'Bills', 'dup'] };
    rows[1_101] = { rowNumber: 1_103, cells: ['2026-10-02', 'Other', 6, 'Bills', 'id-3'] };
    rows[1_102] = { rowNumber: 1_104, cells: [] };
    let pauses = 0;

    const sliced = await validateInSlices(rows, 2, async () => {
      pauses += 1;
    });

    expect(sliced).toEqual(buildLedger(rows, 2));
    expect(pauses).toBe(2);
    expect(sliced.issues.map((issue) => [issue.rowNumber, issue.kind])).toEqual([
      [5, 'conflicting_duplicate'],
      [502, 'invalid_date'],
      [1_102, 'duplicate_resolved'],
      [1_103, 'conflicting_duplicate'],
    ]);
  });

  test('a refresh of a long sheet pauses for the UI while validating', async () => {
    seed(...sheetRows(1_200).map((row) => row.cells));
    let pauses = 0;
    engine = new SubmissionEngine(
      deps({
        pause: async () => {
          pauses += 1;
        },
      }),
    );

    expect(await engine.refresh()).toMatchObject({ kind: 'refreshed', expenseCount: 1_203 });
    // 1,203 rows (3 seeded in beforeEach) in slices of 500.
    expect(pauses).toBe(2);
  });
});
