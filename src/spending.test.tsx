import { fireEvent, renderRouter, screen } from 'expo-router/testing-library';

import { FakeAuthorizer, FakeGoogle } from '../test/fakeGoogle';
import { openTestDatabase, type TestDatabase } from '../test/sqliteTestDatabase';

import { insertConfirmedExpense } from '@/db/confirmedExpenses';
import { migrateDatabase } from '@/db/migrations';
import type { SqlDatabase } from '@/db/sql';
import { parseLocalDate, todayLocalDate, type LocalDate } from '@/domain/dates';
import type { DataScope } from '@/domain/expense';
import type { GoogleServices } from '@/google/services';
import { connectGoogle } from '@/sync/connection';
import { formatSyncTime } from '@/ui/spendingFormat';

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

let mockOnline = true;
jest.mock('@/sync/platform', () => ({
  createPlatformServices: () => ({
    isOnline: async () => mockOnline,
    onConnectivityRegained: () => () => undefined,
    newId: () => 'unused',
    now: () => Date.parse('2026-11-22T03:04:00Z'),
  }),
}));

const ALICE = 'sub-alice';
const today = todayLocalDate();
const [thisYear, thisMonth] = today.split('-');
const d = (value: string) => parseLocalDate(value) as LocalDate;

let testDb: TestDatabase;
let google: FakeGoogle;
let scope: DataScope;

beforeEach(async () => {
  testDb = openTestDatabase();
  await migrateDatabase(testDb.db);
  mockDatabase = testDb.db;
  google = new FakeGoogle();
  google.addAccount(ALICE, 'alice@example.com');
  const authorizer = new FakeAuthorizer(google, [ALICE]);
  mockServices = { authorizer, fetch: google.fetch };
  const state = await connectGoogle({ db: testDb.db, authorizer, fetch: google.fetch }, { interactive: true });
  if (state.kind !== 'ready') throw new Error('setup failed');
  scope = { accountId: ALICE, spreadsheetId: state.spreadsheetId };
  mockOnline = true;
  google.log.length = 0;
});

afterEach(() => {
  testDb.close();
  mockDatabase = null;
  mockServices = null;
});

async function openMySpending() {
  await renderRouter('src/app');
  await fireEvent.press(await screen.findByTestId('tab-my-spending'));
  return screen.findByTestId('spending-results');
}

async function seedCache() {
  await insertConfirmedExpense(testDb.db, scope, { expenseId: 'c1', purchaseDate: today, description: 'Rent', amountMinor: 50_000, category: 'Bills' });
  await insertConfirmedExpense(testDb.db, scope, { expenseId: 'c2', purchaseDate: today, description: 'Food', amountMinor: 25_000, category: 'Groceries' });
  await insertConfirmedExpense(testDb.db, scope, { expenseId: 'c3', purchaseDate: d('2024-03-10'), description: 'Old', amountMinor: 1_000, category: 'Other' });
  testDb.raw.prepare("UPDATE app_settings SET last_successful_sync_at = '2026-11-20T09:30:00.000Z' WHERE id = 1").run();
}

test('cached results show immediately without contacting Google', async () => {
  await seedCache();
  await openMySpending();

  expect(screen.getByTestId('period-total')).toHaveTextContent('$750.00');
  expect(screen.getByTestId('category-row-Bills')).toHaveTextContent(/\$500\.00 · 66\.67%/);
  expect(screen.getByTestId('category-row-Groceries')).toHaveTextContent(/\$250\.00 · 33\.33%/);
  expect(screen.getByTestId('sync-status')).toHaveTextContent(`Last refreshed ${formatSyncTime('2026-11-20T09:30:00.000Z')}.`);
  expect(google.log).toHaveLength(0);
});

test('changing periods uses the local cache only', async () => {
  await seedCache();
  await openMySpending();

  await fireEvent.press(screen.getByTestId('period-all'));
  expect(screen.getByTestId('period-label')).toHaveTextContent('All time');
  expect(await screen.findByText('$760.00')).toBeOnTheScreen();

  await fireEvent.press(screen.getByTestId('period-year'));
  expect(screen.getByTestId('period-label')).toHaveTextContent(thisYear ?? '');
  await fireEvent.press(screen.getByTestId('period-month'));
  await fireEvent.press(screen.getByTestId('period-previous'));
  expect(await screen.findByText('No confirmed expenses in this period.')).toBeOnTheScreen();
  expect(screen.getByTestId('period-total')).toHaveTextContent('$0.00');
  expect(google.log).toHaveLength(0);
  expect(thisMonth).toBeDefined();
});

test('the first visit with an empty cache loads the sheet', async () => {
  google.userEdit(scope.spreadsheetId, (rows) => {
    rows.push([today, 'Groceries run', 82.4, 'Groceries', 'r1'], [today, 'Bus', 3.8, 'Transport', 'r2']);
  });

  await openMySpending();

  expect(await screen.findByText('$86.20')).toBeOnTheScreen();
  expect(screen.getByTestId('sync-status')).toHaveTextContent(`Last refreshed ${formatSyncTime('2026-11-22T03:04:00.000Z')}.`);
});

test('Refresh shows corrections and deletions made in Google Sheets', async () => {
  google.userEdit(scope.spreadsheetId, (rows) => {
    rows.push([today, 'Groceries run', 82.4, 'Groceries', 'r1'], [today, 'Bus', 3.8, 'Transport', 'r2']);
  });
  await openMySpending();
  await screen.findByText('$86.20');

  google.userEdit(scope.spreadsheetId, (rows) => {
    rows[1] = [today, 'Groceries run', 28.4, 'Groceries', 'r1'];
    rows.splice(2, 1);
  });
  await fireEvent.press(screen.getByTestId('refresh'));

  expect(await screen.findByText('$28.40')).toBeOnTheScreen();
  expect(screen.queryByTestId('category-row-Transport')).toBeNull();
});

test('a failed refresh keeps cached results and says when the last good refresh was', async () => {
  await seedCache();
  await openMySpending();
  mockOnline = false;

  await fireEvent.press(screen.getByTestId('refresh'));

  expect(await screen.findByText('Couldn’t refresh: no connection to Google. Showing saved results.')).toBeOnTheScreen();
  expect(screen.getByTestId('last-refresh')).toHaveTextContent(`Last successful refresh ${formatSyncTime('2026-11-20T09:30:00.000Z')}.`);
  expect(screen.getByTestId('period-total')).toHaveTextContent('$750.00');
});

test('rows that need fixing are listed with row numbers and excluded from totals', async () => {
  google.userEdit(scope.spreadsheetId, (rows) => {
    rows.push([today, 'Ok', 10, 'Other', 'ok'], [today, 'Typo', 'ten', 'Other', 'bad'], [today, 'No id', 5, 'Other', '']);
  });

  await openMySpending();

  expect(await screen.findByText('Totals exclude 2 rows in your sheet that need fixing:')).toBeOnTheScreen();
  expect(screen.getByText('Row 3: the amount isn’t a valid positive amount.')).toBeOnTheScreen();
  expect(screen.getByText('Row 4: the Expense ID is missing.')).toBeOnTheScreen();
  expect(screen.getByTestId('period-total')).toHaveTextContent('$10.00');
});
