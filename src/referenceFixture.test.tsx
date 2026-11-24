import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';

import { FakeAuthorizer, FakeGoogle } from '../test/fakeGoogle';
import { REFERENCE_EXPECTED, REFERENCE_REPRESENTATIONS, referenceRows } from '../test/fixtures/referenceLedger';
import { openTestDatabase, type TestDatabase } from '../test/sqliteTestDatabase';

import { migrateDatabase } from '@/db/migrations';
import { analyzeSpending } from '@/db/spendingAnalysis';
import type { SqlDatabase } from '@/db/sql';
import { parseLocalDate, type LocalDate } from '@/domain/dates';
import type { DataScope } from '@/domain/expense';
import type { GoogleServices } from '@/google/services';
import { connectGoogle } from '@/sync/connection';
import { SubmissionEngine } from '@/sync/submissions';

let mockDatabase: SqlDatabase | null = null;
jest.mock('@/db/DatabaseProvider', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { DatabaseContext } = jest.requireActual<typeof import('@/db/DatabaseContext')>('@/db/DatabaseContext');
  return {
    DatabaseProvider: ({ children }: { children: React.ReactNode }) =>
      React.createElement(DatabaseContext.Provider, { value: mockDatabase }, children),
  };
});

let mockServices: GoogleServices | null = null;
jest.mock('@/google/services', () => ({ createDefaultGoogleServices: () => mockServices }));

jest.mock('@/sync/platform', () => ({
  createPlatformServices: () => ({
    isOnline: async () => true,
    onConnectivityRegained: () => () => undefined,
    newId: () => 'unused',
    now: () => Date.parse('2026-11-22T03:04:00Z'),
  }),
}));

const ALICE = 'sub-alice';
const d = (value: string) => parseLocalDate(value) as LocalDate;

let testDb: TestDatabase;
let google: FakeGoogle;
let authorizer: FakeAuthorizer;
let scope: DataScope;

beforeEach(async () => {
  testDb = openTestDatabase();
  await migrateDatabase(testDb.db);
  mockDatabase = testDb.db;
  google = new FakeGoogle();
  google.addAccount(ALICE, 'alice@example.com');
  authorizer = new FakeAuthorizer(google, [ALICE]);
  mockServices = { authorizer, fetch: google.fetch };
  const state = await connectGoogle({ db: testDb.db, authorizer, fetch: google.fetch }, { interactive: true });
  if (state.kind !== 'ready') throw new Error('setup failed');
  scope = { accountId: ALICE, spreadsheetId: state.spreadsheetId };
  google.log.length = 0;
});

afterEach(() => {
  testDb.close();
  mockDatabase = null;
  mockServices = null;
});

function seed(toCells: (cells: ReturnType<typeof referenceRows>[number]) => unknown[]) {
  google.userEdit(scope.spreadsheetId, (sheet) => {
    sheet.push(...referenceRows().map(toCells));
  });
}

/** Reads of the ledger itself (the header check reads only A1:E2). */
const ledgerReads = () => google.requests('GET', '/values/').filter((request) => !request.path.includes('A1%3AE2'));

test('the fixture file holds the five reference rows', () => {
  expect(referenceRows().map(([date, , amount, category]) => [date, category, amount])).toEqual([
    ['2025-12-31', 'Transport', '5.00'],
    ['2026-10-08', 'Groceries', '42.50'],
    ['2026-10-08', 'Transport', '7.50'],
    ['2026-10-09', 'Groceries', '10.00'],
    ['2026-11-01', 'Bills', '20.00'],
  ]);
});

describe.each(REFERENCE_REPRESENTATIONS)('reference fixture %s', (_label, toCells) => {
  test('refresh, then the analysis contract returns the expected results', async () => {
    seed(toCells);
    const engine = new SubmissionEngine({
      db: testDb.db,
      authorizer,
      fetch: google.fetch,
      isOnline: async () => true,
      newId: () => 'unused',
      now: () => Date.parse('2026-11-22T03:04:00Z'),
    });

    expect(await engine.refresh()).toMatchObject({ kind: 'refreshed' });

    expect(await analyzeSpending(testDb.db, scope, { kind: 'day', date: d('2026-10-08') })).toMatchObject({
      start: '2026-10-08',
      endExclusive: '2026-10-09',
      totalMinor: REFERENCE_EXPECTED.day20261008,
    });
    expect(await analyzeSpending(testDb.db, scope, { kind: 'month', year: 2026, month: 10 })).toMatchObject({
      start: '2026-10-01',
      endExclusive: '2026-11-01',
      ...REFERENCE_EXPECTED.october2026,
      excludedRowCount: 0,
    });
    expect(await analyzeSpending(testDb.db, scope, { kind: 'year', year: 2026 })).toMatchObject({
      start: '2026-01-01',
      endExclusive: '2027-01-01',
      totalMinor: REFERENCE_EXPECTED.year2026,
    });
    expect(await analyzeSpending(testDb.db, scope, { kind: 'all' })).toMatchObject({
      start: null,
      endExclusive: null,
      totalMinor: REFERENCE_EXPECTED.allTime,
    });
  });
});

async function choose(kind: 'day' | 'month' | 'year', date: Date) {
  await fireEvent.press(screen.getByTestId(`period-${kind}`));
  await fireEvent.press(screen.getByTestId('period-choose'));
  await fireEvent(screen.getByTestId('period-date-picker'), 'change', { nativeEvent: { timestamp: date.getTime(), utcOffset: 0 } });
}

test('My spending shows the expected results, and period switches stay local', async () => {
  seed(REFERENCE_REPRESENTATIONS[1]?.[1] ?? ((cells) => cells));
  await renderRouter('src/app');
  await fireEvent.press(await screen.findByTestId('tab-my-spending'));
  // First visit with an empty cache loads the sheet once.
  await screen.findByText(/^Last refreshed .*\. Showing saved results\.$/);
  const readsAfterFirstLoad = ledgerReads().length;
  expect(readsAfterFirstLoad).toBeGreaterThan(0);

  await choose('day', new Date(2026, 9, 8, 12));
  expect(await screen.findByText('8 Oct 2026')).toBeOnTheScreen();
  expect(screen.getByTestId('period-total')).toHaveTextContent('$50.00');

  await choose('month', new Date(2026, 9, 8, 12));
  expect(await screen.findByText('October 2026')).toBeOnTheScreen();
  expect(screen.getByTestId('period-total')).toHaveTextContent('$60.00');
  expect(screen.getByTestId('category-row-Groceries')).toHaveTextContent('Groceries$52.50 · 87.5%');
  expect(screen.getByTestId('category-row-Transport')).toHaveTextContent('Transport$7.50 · 12.5%');
  await fireEvent.press(screen.getByTestId('chart-pie'));
  expect(screen.getByTestId('pie-chart')).toHaveAccessibleName('Pie chart of spending by category. Groceries 87.5 percent, Transport 12.5 percent.');
  expect(screen.getByTestId('category-row-Groceries')).toHaveTextContent('Groceries$52.50 · 87.5%');

  await choose('year', new Date(2026, 5, 1, 12));
  expect(await screen.findByText('$80.00')).toBeOnTheScreen();
  expect(screen.getByTestId('period-label')).toHaveTextContent('2026');

  await fireEvent.press(screen.getByTestId('period-all'));
  expect(await screen.findByText('$85.00')).toBeOnTheScreen();

  expect(ledgerReads()).toHaveLength(readsAfterFirstLoad);
});

test('opening the app on Add expense never reads the ledger', async () => {
  seed(REFERENCE_REPRESENTATIONS[0]?.[1] ?? ((cells) => cells));
  await renderRouter('src/app');

  expect(await screen.findByTestId('expense-form')).toBeOnTheScreen();
  // Let any deferred startup work (retry timers, connectivity checks) run too.
  await act(() => jest.advanceTimersByTimeAsync(60_000));
  expect(ledgerReads()).toHaveLength(0);
});
