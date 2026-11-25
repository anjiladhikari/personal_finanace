import { act, fireEvent, renderRouter, screen, within } from 'expo-router/testing-library';
import { Dimensions } from 'react-native';
import type { pieDataItem } from 'react-native-gifted-charts';

import { FakeAuthorizer, FakeGoogle } from '../test/fakeGoogle';
import { openTestDatabase, type TestDatabase } from '../test/sqliteTestDatabase';

import { insertConfirmedExpense } from '@/db/confirmedExpenses';
import { migrateDatabase } from '@/db/migrations';
import * as spendingAnalysis from '@/db/spendingAnalysis';
import type { SqlDatabase } from '@/db/sql';
import { parseLocalDate, periodContaining, shiftPeriod, todayLocalDate, type LocalDate } from '@/domain/dates';
import type { DataScope } from '@/domain/expense';
import type { GoogleServices } from '@/google/services';
import { connectGoogle } from '@/sync/connection';
import { categoryColor } from '@/ui/categoryColors';
import { formatSyncTime, periodLabel } from '@/ui/spendingFormat';

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

// Record what the real pie is asked to draw, then draw it.
const mockPieData: pieDataItem[][] = [];
jest.mock('react-native-gifted-charts', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const actual = jest.requireActual<typeof import('react-native-gifted-charts')>('react-native-gifted-charts');
  return {
    ...actual,
    PieChart: (props: import('react-native-gifted-charts').PieChartPropsType) => {
      mockPieData.push(props.data);
      return React.createElement(actual.PieChart, props);
    },
  };
});

const ALICE = 'sub-alice';
const today = todayLocalDate();
const [thisYear] = today.split('-');
const d = (value: string) => parseLocalDate(value) as LocalDate;
const DEFAULT_WINDOW = Dimensions.get('window');

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
  mockOnline = true;
  google.log.length = 0;
  mockPieData.length = 0;
});

afterEach(() => {
  testDb.close();
  mockDatabase = null;
  mockServices = null;
  jest.restoreAllMocks();
  Dimensions.set({ window: DEFAULT_WINDOW, screen: DEFAULT_WINDOW });
});

async function openMySpending() {
  await renderRouter('src/app');
  await fireEvent.press(await screen.findByTestId('tab-my-spending'));
  return screen.findByTestId('spending-results');
}

function markRefreshed() {
  testDb.raw.prepare("UPDATE app_settings SET last_successful_sync_at = '2026-11-20T09:30:00.000Z' WHERE id = 1").run();
}

async function seedCache() {
  await insertConfirmedExpense(testDb.db, scope, { expenseId: 'c1', purchaseDate: today, description: 'Rent', amountMinor: 50_000, category: 'Bills' });
  await insertConfirmedExpense(testDb.db, scope, { expenseId: 'c2', purchaseDate: today, description: 'Food', amountMinor: 25_000, category: 'Groceries' });
  await insertConfirmedExpense(testDb.db, scope, { expenseId: 'c3', purchaseDate: d('2024-03-10'), description: 'Old', amountMinor: 1_000, category: 'Other' });
  markRefreshed();
}

/** testIDs in screen order, to check the layout sequence. */
function testIdsInOrder(): string[] {
  const ids: string[] = [];
  const walk = (node: unknown) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const { props, children } = node as { props?: { testID?: unknown }; children?: unknown };
    if (typeof props?.testID === 'string') ids.push(props.testID);
    walk(children);
  };
  walk(screen.toJSON());
  return ids;
}

function isChecked(testID: string): boolean {
  return screen.getByTestId(testID).props.accessibilityState?.checked === true;
}

test('cached results show immediately without contacting Google', async () => {
  await seedCache();
  await openMySpending();

  expect(screen.getByTestId('period-total')).toHaveTextContent('$750.00');
  expect(screen.getByTestId('category-row-Bills')).toHaveTextContent(/\$500\.00 · 66\.7%/);
  expect(screen.getByTestId('category-row-Groceries')).toHaveTextContent(/\$250\.00 · 33\.3%/);
  expect(screen.getByTestId('sync-status')).toHaveTextContent(`Last refreshed ${formatSyncTime('2026-11-20T09:30:00.000Z')}. Showing saved results.`);
  expect(google.log).toHaveLength(0);
});

test('opens on the current month as bars, laid out in the agreed order', async () => {
  await seedCache();
  await openMySpending();

  expect(isChecked('period-month')).toBe(true);
  expect(isChecked('chart-bar')).toBe(true);
  expect(screen.getByTestId('period-label')).toHaveTextContent(periodLabel(periodContaining('month', today)));
  expect(screen.getByTestId('bar-chart')).toBeOnTheScreen();

  const order = testIdsInOrder();
  const sequence = ['period-month', 'period-choose', 'period-label', 'period-total', 'chart-bar', 'bar-chart', 'sync-status', 'refresh'];
  const positions = sequence.map((id) => order.indexOf(id));
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
});

test('changing periods uses the local cache only', async () => {
  await seedCache();
  await openMySpending();

  await fireEvent.press(screen.getByTestId('period-all'));
  expect(screen.getByTestId('period-label')).toHaveTextContent('All time');
  expect(screen.queryByTestId('period-choose')).toBeNull();
  expect(await screen.findByText('$760.00')).toBeOnTheScreen();

  await fireEvent.press(screen.getByTestId('period-year'));
  expect(screen.getByTestId('period-label')).toHaveTextContent(thisYear ?? '');
  await fireEvent.press(screen.getByTestId('period-month'));
  await fireEvent.press(screen.getByTestId('period-previous'));
  expect(await screen.findByText('No confirmed expenses in this period.')).toBeOnTheScreen();
  expect(screen.getByTestId('period-total')).toHaveTextContent('$0.00');
  expect(google.log).toHaveLength(0);
});

test('switching chart type keeps the period, and changing period keeps the chart type', async () => {
  await seedCache();
  await openMySpending();
  await fireEvent.press(screen.getByTestId('period-all'));
  await screen.findByText('$760.00');

  await fireEvent.press(screen.getByTestId('chart-pie'));
  expect(isChecked('chart-pie')).toBe(true);
  expect(isChecked('period-all')).toBe(true);
  expect(screen.getByTestId('period-label')).toHaveTextContent('All time');
  expect(screen.getByTestId('pie-chart')).toBeOnTheScreen();
  expect(screen.queryByTestId('bar-chart')).toBeNull();

  await fireEvent.press(screen.getByTestId('period-month'));
  expect(await screen.findByText('$750.00')).toBeOnTheScreen();
  expect(isChecked('chart-pie')).toBe(true);
  expect(screen.getByTestId('pie-chart')).toBeOnTheScreen();

  await fireEvent.press(screen.getByTestId('chart-bar'));
  expect(screen.getByTestId('period-label')).toHaveTextContent(periodLabel(periodContaining('month', today)));
  expect(screen.getByTestId('bar-chart')).toBeOnTheScreen();
});

test('bars, pie slices, percentages and the total all come from one query result', async () => {
  const analyze = jest.spyOn(spendingAnalysis, 'analyzeSpending');
  await seedCache();
  await openMySpending();
  const queries = analyze.mock.calls.length;
  const result = (await analyze.mock.results.at(-1)?.value) as spendingAnalysis.SpendingAnalysis;

  await fireEvent.press(screen.getByTestId('chart-pie'));

  // Switching chart type reuses the result; it does not query again.
  expect(analyze.mock.calls.length).toBe(queries);
  const slices = mockPieData.at(-1) ?? [];
  expect(slices.map((slice) => slice.value)).toEqual(result.categories.map((share) => share.amountMinor));
  expect(slices.reduce((sum, slice) => sum + slice.value, 0)).toBe(result.totalMinor);
  expect(screen.getByTestId('period-total')).toHaveTextContent('$750.00');
  expect(result.totalMinor).toBe(75_000);
  expect(screen.getByTestId('pie-chart')).toHaveAccessibleName('Pie chart of spending by category. Bills 66.7 percent, Groceries 33.3 percent.');
  expect(within(screen.getByTestId('pie-breakdown')).getByTestId('category-row-Bills')).toHaveTextContent('Bills$500.00 · 66.7%');

  await fireEvent.press(screen.getByTestId('chart-bar'));
  expect(analyze.mock.calls.length).toBe(queries);
  expect(screen.getByTestId('category-row-Bills')).toHaveTextContent('Bills$500.00 · 66.7%');
  expect(slices.map((slice) => slice.color)).toEqual([categoryColor('Bills'), categoryColor('Groceries')]);
});

test('choosing a date in the calendar shows the period that contains it', async () => {
  await seedCache();
  await openMySpending();
  await fireEvent.press(screen.getByTestId('chart-pie'));

  await fireEvent.press(screen.getByTestId('period-choose'));
  await fireEvent(screen.getByTestId('period-date-picker'), 'change', {
    nativeEvent: { timestamp: new Date(2024, 2, 15, 12).getTime(), utcOffset: 0 },
  });

  expect(await screen.findByText('$10.00')).toBeOnTheScreen();
  expect(screen.getByTestId('period-label')).toHaveTextContent('March 2024');
  expect(screen.queryByTestId('period-date-picker')).toBeNull();
  expect(isChecked('chart-pie')).toBe(true);
});

test('previous and next step by the selected kind', async () => {
  await seedCache();
  await openMySpending();
  await fireEvent.press(screen.getByTestId('period-day'));
  expect(screen.getByTestId('period-previous')).toHaveAccessibleName('Previous day');

  await fireEvent.press(screen.getByTestId('period-previous'));
  expect(screen.getByTestId('period-label')).toHaveTextContent(periodLabel(shiftPeriod(periodContaining('day', today), -1)));
  await fireEvent.press(screen.getByTestId('period-next'));
  expect(await screen.findByText('$750.00')).toBeOnTheScreen();
});

describe('states', () => {
  test('loading: shown until the saved results are read', async () => {
    jest.spyOn(spendingAnalysis, 'analyzeSpending').mockReturnValue(new Promise(() => undefined));
    await seedCache();
    await renderRouter('src/app');
    await fireEvent.press(await screen.findByTestId('tab-my-spending'));

    expect(await screen.findByTestId('spending-loading')).toHaveTextContent('Loading saved expenses…');
    expect(screen.queryByTestId('period-total')).toBeNull();
  });

  test('empty: no expenses in the period shows zero and no chart', async () => {
    markRefreshed();
    await openMySpending();

    expect(screen.getByTestId('spending-empty')).toHaveTextContent('No confirmed expenses in this period.');
    expect(screen.getByTestId('period-total')).toHaveTextContent('$0.00');
    expect(screen.queryByTestId('chart-bar')).toBeNull();
    expect(screen.queryByTestId('bar-chart')).toBeNull();
    expect(screen.queryByTestId('pie-chart')).toBeNull();
  });

  test('refreshing: the first load says it is loading from Google Sheets, then shows the results', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockServices = {
      authorizer,
      fetch: async (url, init) => {
        if (String(url).includes('/values/')) await gate;
        return google.fetch(url, init);
      },
    };
    google.userEditYear(scope.spreadsheetId, thisYear ?? '', (rows) => {
      rows.push([today, 'Groceries run', 82.4, 'Groceries', 'r1']);
    });

    await openMySpending();

    expect(await screen.findByText('Loading your expenses from Google Sheets…')).toBeOnTheScreen();
    expect(screen.getByTestId('sync-status')).toHaveTextContent('Refreshing from Google Sheets…');
    expect(screen.getByTestId('sync-busy')).toBeOnTheScreen();
    expect(screen.getByTestId('refresh')).toBeDisabled();

    await act(async () => release());

    expect(await screen.findByText('$82.40')).toBeOnTheScreen();
    expect(screen.queryByTestId('spending-empty')).toBeNull();
    expect(screen.getByTestId('refresh')).toBeEnabled();
  });

  test('failed: a failed first load says nothing is loaded yet and why', async () => {
    mockOnline = false;
    await openMySpending();

    expect(await screen.findByText('Couldn’t refresh: no connection to Google. Showing saved results.')).toBeOnTheScreen();
    expect(screen.getByTestId('spending-empty')).toHaveTextContent('Your Google Sheet hasn’t been loaded yet. Use Refresh below to load it.');
    expect(screen.queryByTestId('last-refresh')).toBeNull();
  });
});

test('the first visit with an empty cache loads the sheet', async () => {
  google.userEditYear(scope.spreadsheetId, thisYear ?? '', (rows) => {
    rows.push([today, 'Groceries run', 82.4, 'Groceries', 'r1'], [today, 'Bus', 3.8, 'Transport', 'r2']);
  });

  await openMySpending();

  expect(await screen.findByText('$86.20')).toBeOnTheScreen();
  expect(screen.getByTestId('sync-status')).toHaveTextContent(`Last refreshed ${formatSyncTime('2026-11-22T03:04:00.000Z')}. Showing saved results.`);
});

test('Refresh shows corrections and deletions made in Google Sheets', async () => {
  google.userEditYear(scope.spreadsheetId, thisYear ?? '', (rows) => {
    rows.push([today, 'Groceries run', 82.4, 'Groceries', 'r1'], [today, 'Bus', 3.8, 'Transport', 'r2']);
  });
  await openMySpending();
  await screen.findByText('$86.20');

  google.userEditYear(scope.spreadsheetId, thisYear ?? '', (rows) => {
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
  expect(screen.getByTestId('bar-chart')).toBeOnTheScreen();
});

test('rows that need fixing are listed with row numbers and excluded from totals', async () => {
  google.userEditYear(scope.spreadsheetId, thisYear ?? '', (rows) => {
    rows.push([today, 'Ok', 10, 'Other', 'ok'], [today, 'Typo', 'ten', 'Other', 'bad'], [today, 'No id', 5, 'Other', '']);
  });

  await openMySpending();

  expect(await screen.findByText('Totals exclude 2 rows in your sheet that need fixing:')).toBeOnTheScreen();
  expect(screen.getByText(`${thisYear}, row 3: the amount isn’t a valid positive amount.`)).toBeOnTheScreen();
  expect(screen.getByText(`${thisYear}, row 4: the Expense ID is missing.`)).toBeOnTheScreen();
  expect(screen.getByTestId('period-total')).toHaveTextContent('$10.00');
});

test('a narrow Android phone with the largest system text gets the compact layout', async () => {
  const narrow = { width: 320, height: 640, scale: 2, fontScale: 2 };
  Dimensions.set({ window: narrow, screen: narrow });
  await seedCache();
  await openMySpending();

  // Period buttons wrap into two rows instead of squeezing four across;
  // 40 dp segments with 4 dp of hit slop above and below keep a 48 dp target.
  expect(screen.getByTestId('period-month')).toHaveStyle({ flexBasis: '45%', minHeight: 40 });
  expect(screen.getByTestId('period-month').props.hitSlop).toEqual({ top: 4, bottom: 4 });
  // Name and amount stack, so neither is cut off.
  expect(screen.getByText('Groceries').parent).toHaveStyle({ flexDirection: 'column' });
  // The total shrinks to fit on one line rather than overflowing.
  expect(screen.getByTestId('period-total').props.adjustsFontSizeToFit).toBe(true);

  await fireEvent.press(screen.getByTestId('chart-pie'));
  expect(screen.getByText('Groceries').parent).toHaveStyle({ flexDirection: 'column' });
});
