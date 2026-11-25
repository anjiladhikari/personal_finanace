import { FakeAuthorizer, FakeGoogle } from '../../test/fakeGoogle';
import { openTestDatabase, type TestDatabase } from '../../test/sqliteTestDatabase';

import { insertCustomCategory, listCustomCategories } from '@/db/categories';
import { insertConfirmedExpense, listConfirmedExpenses } from '@/db/confirmedExpenses';
import { migrateDatabase } from '@/db/migrations';
import { insertPendingSubmission, listPendingSubmissions } from '@/db/pendingSubmissions';
import { analyzeSpending } from '@/db/spendingAnalysis';
import { listPendingTabSorts } from '@/db/tabSorts';
import { parseLocalDate, type LocalDate } from '@/domain/dates';
import type { DataScope, ExpensePayload } from '@/domain/expense';
import { EXPENSE_COLUMNS } from '@/domain/sheetContract';

import { connectGoogle } from './connection';
import { SubmissionEngine, type SubmissionDeps } from './submissions';

const ALICE = 'sub-alice';
const d = (value: string) => parseLocalDate(value) as LocalDate;

let google: FakeGoogle;
let authorizer: FakeAuthorizer;
let phone: TestDatabase;
let scope: DataScope;
let online: boolean;
let clock: number;
let ids: number;

function deps(): SubmissionDeps {
  return {
    db: phone.db,
    authorizer,
    fetch: google.fetch,
    isOnline: async () => online,
    newId: () => `id-${(ids += 1)}`,
    now: () => clock,
  };
}

const expense = (date: string, description: string, amountMinor = 1_000, category = 'Groceries'): ExpensePayload => ({
  purchaseDate: d(date),
  description,
  amountMinor,
  category,
});

const appends = () => google.requests('POST', ':append');
const addSheets = () =>
  google.requests('POST', ':batchUpdate').filter((r) => JSON.stringify(r.body).includes('"addSheet"'));
const tabOf = (title: string) => google.files.get(scope.spreadsheetId)?.tabs.find((t) => t.title === title);

beforeEach(async () => {
  google = new FakeGoogle();
  google.addAccount(ALICE, 'alice@example.com');
  authorizer = new FakeAuthorizer(google, [ALICE]);
  phone = openTestDatabase();
  await migrateDatabase(phone.db);
  const state = await connectGoogle({ db: phone.db, authorizer, fetch: google.fetch }, { interactive: true });
  if (state.kind !== 'ready') throw new Error('setup failed');
  scope = { accountId: ALICE, spreadsheetId: state.spreadsheetId };
  online = true;
  clock = Date.parse('2026-11-25T03:00:00Z');
  ids = 0;
  google.log.length = 0;
});

afterEach(() => {
  phone.close();
});

describe('which tab an expense goes into', () => {
  test('the year of its purchase date, not the day it is saved', async () => {
    const engine = new SubmissionEngine(deps());

    await engine.submit(expense('2026-11-20', 'Groceries run'));
    await engine.submit(expense('2025-12-31', 'New Year’s Eve dinner', 9_000, 'Eating out')); // entered in 2026

    expect(google.yearRows(scope.spreadsheetId, '2026')).toEqual([['2026-11-20', 'Groceries run', 10, 'Groceries', 'id-1']]);
    expect(google.yearRows(scope.spreadsheetId, '2025')).toEqual([['2025-12-31', 'New Year’s Eve dinner', 90, 'Eating out', 'id-2']]);
    // The original Expenses worksheet is never written to.
    expect(google.dataRows(scope.spreadsheetId, 0)).toEqual([]);
  });

  test('an offline expense dated December 2026 and synced in January 2027 still goes into 2026', async () => {
    online = false;
    clock = Date.parse('2026-12-30T22:00:00Z');
    const engine = new SubmissionEngine(deps());
    await engine.submit(expense('2026-12-30', 'Late shopping'));
    expect(await listPendingSubmissions(phone.db, scope)).toHaveLength(1);

    online = true;
    clock = Date.parse('2027-01-03T01:00:00Z');
    await engine.processQueue('connectivity');

    expect(await listPendingSubmissions(phone.db, scope)).toEqual([]);
    expect(google.yearRows(scope.spreadsheetId, '2026')).toEqual([['2026-12-30', 'Late shopping', 10, 'Groceries', 'id-1']]);
    expect(google.tabTitles(scope.spreadsheetId)).not.toContain('2027');
  });
});

describe('yearly tabs', () => {
  test('a missing year tab is created once, with the header and a frozen first row; later saves reuse it', async () => {
    const engine = new SubmissionEngine(deps());

    await engine.submit(expense('2024-03-01', 'One'));
    await engine.submit(expense('2024-03-02', 'Two'));

    expect(google.tabTitles(scope.spreadsheetId).filter((t) => t === '2024')).toHaveLength(1);
    expect(addSheets()).toHaveLength(1);
    expect(tabOf('2024')?.rows[0]).toEqual([...EXPENSE_COLUMNS]);
    expect(tabOf('2024')?.frozenRowCount).toBe(1);
    expect(google.yearRows(scope.spreadsheetId, '2024')).toHaveLength(2);
  });

  test('an existing empty year tab is reused (the header is added), never duplicated', async () => {
    google.userEdit(scope.spreadsheetId, () => undefined); // touch
    const file = google.files.get(scope.spreadsheetId);
    file?.tabs.push({ sheetId: 77, title: '2023', index: 9, frozenRowCount: 0, rows: [] });

    await new SubmissionEngine(deps()).submit(expense('2023-07-14', 'Made by hand'));

    expect(google.tabTitles(scope.spreadsheetId).filter((t) => t.startsWith('2023'))).toEqual(['2023']);
    expect(tabOf('2023')?.rows[0]).toEqual([...EXPENSE_COLUMNS]);
    expect(google.yearRows(scope.spreadsheetId, '2023')).toEqual([['2023-07-14', 'Made by hand', 10, 'Groceries', 'id-1']]);
  });

  test('a year tab with a different header is never written to', async () => {
    google.userEditYear(scope.spreadsheetId, '2022', (rows) => {
      rows[0] = ['Budget', 'Notes'];
    });

    expect(await new SubmissionEngine(deps()).submit(expense('2022-05-05', 'Old'))).toMatchObject({
      kind: 'unresolved',
      state: 'blocked',
      error: 'sheet_structure_changed',
    });
    expect(appends()).toEqual([]);
    expect(tabOf('2022')?.rows).toEqual([['Budget', 'Notes']]);
  });
});

describe('sorting by date', () => {
  test('backdated expenses land in date order, newest first; whole rows move together and the header stays first', async () => {
    const engine = new SubmissionEngine(deps());

    await engine.submit(expense('2026-11-20', 'November', 1_100));
    await engine.submit(expense('2026-01-05', 'January', 100));
    await engine.submit(expense('2026-06-15', 'June', 600));
    await engine.submit(expense('2026-01-05', 'January again', 150));

    expect(tabOf('2026')?.rows[0]).toEqual([...EXPENSE_COLUMNS]);
    expect(google.yearRows(scope.spreadsheetId, '2026')).toEqual([
      ['2026-11-20', 'November', 11, 'Groceries', 'id-1'],
      ['2026-06-15', 'June', 6, 'Groceries', 'id-3'],
      ['2026-01-05', 'January', 1, 'Groceries', 'id-2'],
      ['2026-01-05', 'January again', 1.5, 'Groceries', 'id-4'],
    ]);
    // Sorting uses the whole A–E range from row 2, never the Date column alone.
    const sorts = google.requests('POST', ':batchUpdate').filter((r) => JSON.stringify(r.body).includes('sortRange'));
    expect(sorts.length).toBeGreaterThan(0);
    expect(JSON.stringify(sorts[0]?.body)).toContain('"startRowIndex":1,"startColumnIndex":0,"endColumnIndex":5');
    expect(JSON.stringify(sorts[0]?.body)).toContain('"sortOrder":"DESCENDING"');
    expect(await listPendingTabSorts(phone.db, scope.spreadsheetId)).toEqual([]);
  });

  test('if the sort fails after a successful save, it is retried later without saving again', async () => {
    google.userEditYear(scope.spreadsheetId, '2026', (rows) => {
      rows.push(['2026-01-10', 'Already there', 5, 'Bills', 'x1']);
    });
    google.failNext({ method: 'POST', pathIncludes: ':batchUpdate', response: 'network' });
    const engine = new SubmissionEngine(deps());

    expect(await engine.submit(expense('2026-02-01', 'Backdated'))).toEqual({ kind: 'confirmed', submissionId: 'id-1' });
    expect(appends()).toHaveLength(1);
    expect(google.yearRows(scope.spreadsheetId, '2026').map((r) => r[4])).toEqual(['x1', 'id-1']); // not yet sorted
    expect(await listPendingTabSorts(phone.db, scope.spreadsheetId)).toEqual(['2026']);

    await engine.processQueue('foreground');

    expect(appends()).toHaveLength(1);
    expect(google.yearRows(scope.spreadsheetId, '2026').map((r) => r[4])).toEqual(['id-1', 'x1']);
    expect(await listPendingTabSorts(phone.db, scope.spreadsheetId)).toEqual([]);
  });

  test('a lost response is reconciled by Expense ID in the year tab: no second row, even after sorting', async () => {
    google.failNext({ method: 'POST', pathIncludes: ':append', response: 'network_after_commit' });
    const engine = new SubmissionEngine(deps());

    expect(await engine.submit(expense('2025-08-01', 'Lost reply'))).toMatchObject({ kind: 'unresolved', state: 'uncertain' });
    await engine.submit(expense('2025-01-01', 'Earlier'));
    await engine.processQueue('foreground');

    expect(appends()).toHaveLength(2);
    expect(google.yearRows(scope.spreadsheetId, '2025').map((r) => r[4])).toEqual(['id-1', 'id-2']);
    expect(await listPendingSubmissions(phone.db, scope)).toEqual([]);
    expect((await listConfirmedExpenses(phone.db, scope, null)).map((e) => e.expenseId).sort()).toEqual(['id-1', 'id-2']);
  });
});

describe('refresh across yearly tabs', () => {
  beforeEach(async () => {
    // The original worksheet with old test data: never read again.
    google.userEdit(scope.spreadsheetId, (rows) => {
      rows.push(['2026-10-08', 'Old test', 999, 'Bills', 'old-1']);
    });
    google.seedExpenseRows(scope.spreadsheetId, [
      ['2024-02-29', 'Leap day', 3, 'Health', 'a'],
      ['2025-12-31', 'Bus', 5, 'Transport', 'b'],
      ['2026-10-08', 'Groceries', 42.5, 'Groceries', 'c'],
      ['2026-10-08', 'Train', 7.5, 'Transport', 'd'],
      ['2026-10-09', 'Top-up', 10, 'Groceries', 'e'],
      ['2026-11-01', 'Bill', 20, 'Bills', 'f'],
    ]);
  });

  test('day, month, year and all-time totals come from every yearly tab, and the old worksheet is left out', async () => {
    expect(await new SubmissionEngine(deps()).refresh()).toMatchObject({ kind: 'refreshed', expenseCount: 6 });

    const total = async (period: Parameters<typeof analyzeSpending>[2]) => (await analyzeSpending(phone.db, scope, period)).totalMinor;
    expect(await total({ kind: 'day', date: d('2026-10-08') })).toBe(5_000);
    expect(await total({ kind: 'month', year: 2026, month: 10 })).toBe(6_000);
    expect(await total({ kind: 'year', year: 2026 })).toBe(8_000);
    expect(await total({ kind: 'year', year: 2025 })).toBe(500);
    expect(await total({ kind: 'day', date: d('2024-02-29') })).toBe(300);
    expect(await total({ kind: 'all' })).toBe(8_800);
    expect((await listConfirmedExpenses(phone.db, scope, null)).map((e) => e.expenseId)).not.toContain('old-1');
  });

  test('replaces the old cache; waiting expenses and custom categories stay', async () => {
    await insertConfirmedExpense(phone.db, scope, { expenseId: 'cached-old', purchaseDate: d('2026-10-01'), description: 'x', amountMinor: 1, category: 'Bills' });
    await insertPendingSubmission(phone.db, scope, {
      submissionId: 'waiting',
      createdAt: '2026-11-25T00:00:00.000Z',
      purchaseDate: d('2026-11-24'),
      description: 'Not sent',
      amountMinor: 1,
      category: 'Bills',
    });
    await insertCustomCategory(phone.db, ALICE, { id: 'c1', name: 'Kids', icon: 'tag', colour: 'red', createdAt: 'x' });
    await new SubmissionEngine(deps()).refresh();

    const confirmedIds = (await listConfirmedExpenses(phone.db, scope, null)).map((e) => e.expenseId);
    expect(confirmedIds).not.toContain('cached-old');
    expect(confirmedIds).toHaveLength(6);
    expect((await listPendingSubmissions(phone.db, scope)).map((p) => p.submissionId)).toContain('waiting');
    expect((await listCustomCategories(phone.db, ALICE)).map((c) => c.name)).toEqual(['Kids']);
  });

  test('a failed refresh keeps the existing cache', async () => {
    const engine = new SubmissionEngine(deps());
    await engine.refresh();
    const before = await listConfirmedExpenses(phone.db, scope, null);
    google.userEditYear(scope.spreadsheetId, '2026', (rows) => rows.splice(1, 3));
    google.failNext({ method: 'GET', pathIncludes: "'2026'!A2", response: 'network' });

    expect(await engine.refresh()).toMatchObject({ kind: 'failed' });
    expect(await listConfirmedExpenses(phone.db, scope, null)).toEqual(before);
  });
});
