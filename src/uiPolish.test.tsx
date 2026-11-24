import { act, fireEvent, renderRouter, screen, within } from 'expo-router/testing-library';
import { DeviceEventEmitter, Dimensions, StyleSheet } from 'react-native';

import { FakeAuthorizer, FakeGoogle } from '../test/fakeGoogle';
import { openTestDatabase, type TestDatabase } from '../test/sqliteTestDatabase';

import { insertConfirmedExpense } from '@/db/confirmedExpenses';
import { migrateDatabase } from '@/db/migrations';
import type { SqlDatabase } from '@/db/sql';
import { todayLocalDate } from '@/domain/dates';
import type { DataScope } from '@/domain/expense';
import type { GoogleServices } from '@/google/services';
import { connectGoogle } from '@/sync/connection';
import { categoryColor } from '@/ui/categoryColors';
import { CONFIRMATION_MS } from '@/ui/ExpenseForm';
import { formatSyncTime } from '@/ui/spendingFormat';
import { themes } from '@/ui/theme';

let mockScheme: 'light' | 'dark' = 'light';
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({ __esModule: true, default: () => mockScheme }));

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

const mockNow = Date.parse('2026-11-24T01:15:00Z');
let mockOnline = true;
let mockIds = 0;
jest.mock('@/sync/platform', () => ({
  createPlatformServices: () => ({
    isOnline: async () => mockOnline,
    onConnectivityRegained: () => () => undefined,
    newId: () => `uuid-${(mockIds += 1)}`,
    now: () => mockNow,
  }),
}));

const ALICE = 'sub-alice';
const DEFAULT_WINDOW = Dimensions.get('window');
const today = todayLocalDate();

let testDb: TestDatabase;
let google: FakeGoogle;
let scope: DataScope;
let failSaves = false;

/** The test database, except that saving on the phone can be made to fail. */
function withFailingSaves(base: SqlDatabase): SqlDatabase {
  return {
    execScript: (sql) => base.execScript(sql),
    run: (sql, params) =>
      failSaves && sql.includes('INSERT INTO pending_submissions') ? Promise.reject(new Error('disk full')) : base.run(sql, params),
    getFirst: (sql, params) => base.getFirst(sql, params),
    getAll: (sql, params) => base.getAll(sql, params),
    transaction: (task) => base.transaction(task),
  };
}

beforeEach(async () => {
  testDb = openTestDatabase();
  await migrateDatabase(testDb.db);
  mockDatabase = withFailingSaves(testDb.db);
  google = new FakeGoogle();
  google.addAccount(ALICE, 'alice@example.com');
  const authorizer = new FakeAuthorizer(google, [ALICE]);
  mockServices = { authorizer, fetch: google.fetch };
  const state = await connectGoogle({ db: testDb.db, authorizer, fetch: google.fetch }, { interactive: true });
  if (state.kind !== 'ready') throw new Error('setup failed');
  scope = { accountId: ALICE, spreadsheetId: state.spreadsheetId };
  mockOnline = true;
  mockIds = 0;
  mockScheme = 'light';
  failSaves = false;
});

afterEach(() => {
  testDb.close();
  mockDatabase = null;
  mockServices = null;
  Dimensions.set({ window: DEFAULT_WINDOW, screen: DEFAULT_WINDOW });
});

async function fill(description = 'Coffee', amount = '4.50') {
  await fireEvent.changeText(await screen.findByLabelText('Amount in AUD'), amount);
  await fireEvent.changeText(screen.getByLabelText('Description'), description);
  await fireEvent.press(screen.getByTestId('category-Eating out'));
}

const style = (testID: string) => StyleSheet.flatten(screen.getByTestId(testID).props.style) as Record<string, unknown>;

function markRefreshed() {
  testDb.raw.prepare("UPDATE app_settings SET last_successful_sync_at = '2026-11-20T09:30:00.000Z' WHERE id = 1").run();
}

describe('Add expense', () => {
  test('the amount leads: AUD badge, decimal keypad and display-size digits', async () => {
    await renderRouter('src/app');

    // The badge is visual; the input's spoken name already says AUD.
    expect(await screen.findByTestId('currency-badge', { includeHiddenElements: true })).toHaveTextContent('AUD');
    const amount = screen.getByLabelText('Amount in AUD');
    expect(amount.props.keyboardType).toBe('decimal-pad');
    expect(style('amount-input').fontSize).toBe(40);
    expect(style('description-input').fontSize).toBeLessThan(40);
    // Large system text still scales the amount, up to 1.5× so it stays on one line.
    expect(amount.props.maxFontSizeMultiplier).toBe(1.5);
  });

  test('Save sits in a footer outside the scrolling form and rises with the keyboard', async () => {
    await renderRouter('src/app');
    const form = await screen.findByTestId('expense-form');

    expect(within(screen.getByTestId('save-footer')).getByTestId('save-expense')).toBeOnTheScreen();
    expect(within(screen.getByTestId('expense-form-scroll')).queryByTestId('save-expense')).toBeNull();

    await fireEvent(form, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 600 } }, persist: () => undefined });
    await act(async () => {
      // Jest renders as iOS, where the view listens for keyboardWillShow (Android: keyboardDidShow).
      DeviceEventEmitter.emit('keyboardWillShow', {
        startCoordinates: { screenX: 0, screenY: 800, width: 360, height: 0 },
        endCoordinates: { screenX: 0, screenY: 400, width: 360, height: 300 },
        duration: 0,
        easing: 'keyboard',
      });
    });

    // The form pads itself by the part of the keyboard that overlaps it, so the footer moves above it.
    expect(Number(style('expense-form').paddingBottom)).toBeGreaterThan(0);
    expect(within(form).getByTestId('save-expense')).toBeOnTheScreen();
  });

  test('category chips show an icon and label; the chosen one is filled, ticked and announced', async () => {
    await renderRouter('src/app');
    const groceries = await screen.findByTestId('category-Groceries');

    expect(within(groceries).getByTestId('icon-groceries', { includeHiddenElements: true })).toBeTruthy();
    expect(within(groceries).getByText('Groceries')).toBeOnTheScreen();
    expect(groceries).not.toBeChecked();

    await fireEvent.press(groceries);

    expect(screen.getByRole('radio', { name: 'Groceries' })).toBeChecked();
    expect(within(screen.getByTestId('category-Groceries')).getByTestId('icon-check', { includeHiddenElements: true })).toBeTruthy();
    expect(style('category-Groceries').backgroundColor).toBe(themes.light.colors.accent);
    expect(style('category-Transport').backgroundColor).toBe(themes.light.colors.surface);
  });

  test('a confirmed save shows a brief, announced confirmation, then hides it', async () => {
    await renderRouter('src/app');
    await fill();

    await fireEvent.press(screen.getByTestId('save-expense'));

    const confirmation = await screen.findByTestId('save-confirmation');
    expect(confirmation).toHaveTextContent('Saved to Google Sheets.');
    expect(confirmation.props.accessibilityLiveRegion).toBe('polite');
    expect(screen.getByTestId('last-confirmed-save')).toHaveTextContent(`Last saved to Google Sheets ${formatSyncTime(new Date(mockNow).toISOString())}.`);

    await act(() => jest.advanceTimersByTimeAsync(CONFIRMATION_MS));
    expect(screen.queryByTestId('save-confirmation')).toBeNull();
  });

  test('a failure to save on the phone is explained beside Save and the draft is kept', async () => {
    failSaves = true;
    await renderRouter('src/app');
    await fill('Lunch', '18.20');

    await fireEvent.press(screen.getByTestId('save-expense'));

    const footer = screen.getByTestId('save-footer');
    expect(await within(footer).findByText('Couldn’t save on this phone. Your entry is still here. Try again.')).toBeOnTheScreen();
    expect(screen.getByLabelText('Description')).toHaveProp('value', 'Lunch');
    expect(screen.getByLabelText('Amount in AUD')).toHaveProp('value', '18.20');
    // It stays until the next attempt.
    await act(() => jest.advanceTimersByTimeAsync(CONFIRMATION_MS * 2));
    expect(within(footer).getByTestId('form-notice')).toBeOnTheScreen();
  });

  test('offline: the pending explanation sits beside Save and the draft is kept', async () => {
    mockOnline = false;
    await renderRouter('src/app');
    await fill();

    await fireEvent.press(screen.getByTestId('save-expense'));

    expect(await within(screen.getByTestId('save-footer')).findByTestId('unresolved-banner')).toHaveTextContent(
      /Saved on this phone, not yet in Google Sheets/,
    );
    // Save now retries that same expense, and says so.
    expect(screen.getByTestId('save-expense')).toHaveTextContent('Try saving again');
    expect(screen.getByLabelText('Description')).toHaveProp('value', 'Coffee');
    expect(screen.getByTestId('last-confirmed-save')).toHaveTextContent('No expenses saved to Google Sheets from this phone yet.');
  });

  test('validation errors appear under their field, not only at the button', async () => {
    await renderRouter('src/app');
    await fireEvent.press(await screen.findByTestId('save-expense'));

    expect(screen.getByTestId('amount-error')).toHaveTextContent('Enter an amount.');
    expect(screen.getByTestId('category-error')).toHaveTextContent('Choose a category.');
    // One message under the group, rather than outlining every chip in red.
    expect(style('category-Groceries').borderColor).toBe(themes.light.colors.outline);
    expect(style('amount-input').color).toBe(themes.light.colors.text);
  });
});

describe('My spending', () => {
  async function open() {
    await renderRouter('src/app');
    await fireEvent.press(await screen.findByTestId('tab-my-spending'));
    return screen.findByTestId('spending-results');
  }

  test('period navigation is one row; Bar / Pie sits in the category card', async () => {
    markRefreshed();
    await insertConfirmedExpense(testDb.db, scope, { expenseId: 'a', purchaseDate: today, description: 'x', amountMinor: 1_000, category: 'Bills' });
    await insertConfirmedExpense(testDb.db, scope, { expenseId: 'b', purchaseDate: today, description: 'y', amountMinor: 500, category: 'Health' });
    await open();

    const nav = screen.getByTestId('period-nav');
    for (const id of ['period-previous', 'period-choose', 'period-next']) expect(within(nav).getByTestId(id)).toBeOnTheScreen();
    const card = screen.getByTestId('breakdown-card');
    expect(within(card).getByTestId('chart-bar')).toBeOnTheScreen();
    expect(within(card).getByTestId('bar-chart')).toBeOnTheScreen();
    expect(style('period-total').fontSize).toBe(40);

    await fireEvent.press(within(card).getByTestId('chart-pie'));
    expect(within(card).getByTestId('pie-chart')).toBeOnTheScreen();
  });

  test('a single category is labelled as such; an empty period shows its message in the card', async () => {
    markRefreshed();
    await insertConfirmedExpense(testDb.db, scope, { expenseId: 'a', purchaseDate: today, description: 'x', amountMinor: 1_000, category: 'Bills' });
    await open();

    expect(screen.getByTestId('single-category-note')).toHaveTextContent('All spending in this period is in Bills.');
    expect(screen.getByTestId('bar-Bills')).toHaveStyle({ width: '100.000%' });

    await fireEvent.press(screen.getByTestId('period-previous'));
    const card = screen.getByTestId('breakdown-card');
    expect(await within(card).findByTestId('spending-empty')).toHaveTextContent('No confirmed expenses in this period.');
    expect(within(card).queryByTestId('chart-bar')).toBeNull();
    expect(screen.queryByTestId('single-category-note')).toBeNull();
  });

  test('saves and full-history refreshes have separate states and timestamps', async () => {
    markRefreshed();
    await open();

    expect(screen.getByTestId('save-status')).toHaveTextContent('No expenses saved from this phone yet.');
    expect(screen.getByTestId('sync-status')).toHaveTextContent(`Last refreshed ${formatSyncTime('2026-11-20T09:30:00.000Z')}. Showing saved results.`);

    await fireEvent.press(screen.getByTestId('tab-add-expense'));
    await fill();
    await fireEvent.press(screen.getByTestId('save-expense'));
    await screen.findByTestId('save-confirmation');
    await fireEvent.press(screen.getByTestId('tab-my-spending'));

    expect(await screen.findByText(`All sent. Last confirmed ${formatSyncTime(new Date(mockNow).toISOString())}.`)).toBeOnTheScreen();
    // A save is not a refresh: the full-history time is unchanged.
    expect(screen.getByTestId('sync-status')).toHaveTextContent(`Last refreshed ${formatSyncTime('2026-11-20T09:30:00.000Z')}. Showing saved results.`);

    mockOnline = false;
    await fireEvent.press(screen.getByTestId('tab-add-expense'));
    await fill('Bus', '3.80');
    await fireEvent.press(screen.getByTestId('save-expense'));
    await screen.findByTestId('unresolved-banner');
    await fireEvent.press(screen.getByTestId('tab-my-spending'));

    expect(await screen.findByText('1 expense waiting to be sent to Google Sheets.')).toBeOnTheScreen();
  });

  test('long category names on a 320 dp phone with the largest text: the card header stacks, names wrap in full', async () => {
    const narrow = { width: 320, height: 640, scale: 2, fontScale: 2 };
    Dimensions.set({ window: narrow, screen: narrow });
    markRefreshed();
    const long = 'Children’s after-school activities and sport registrations';
    await insertConfirmedExpense(testDb.db, scope, { expenseId: 'a', purchaseDate: today, description: 'x', amountMinor: 4_000, category: long });
    await insertConfirmedExpense(testDb.db, scope, { expenseId: 'b', purchaseDate: today, description: 'y', amountMinor: 1_000, category: 'Bills' });
    await open();

    const name = screen.getByText(long);
    expect(name.props.numberOfLines).toBeUndefined();
    expect(name.parent).toHaveStyle({ flexDirection: 'column' });
    expect(within(screen.getByTestId('breakdown-card')).getByText('By category').parent).toHaveStyle({ flexDirection: 'column' });
    expect(screen.getByTestId('period-day')).toHaveStyle({ flexBasis: '45%' });
  });
});

describe('dark mode', () => {
  test('Add expense uses the dark tokens', async () => {
    mockScheme = 'dark';
    await renderRouter('src/app');

    expect((await screen.findByTestId('expense-form'))).toHaveStyle({ backgroundColor: themes.dark.colors.background });
    expect(screen.getByTestId('save-expense')).toHaveStyle({ backgroundColor: themes.dark.colors.accent });
    expect(screen.getByLabelText('Amount in AUD')).toHaveStyle({ color: themes.dark.colors.text });
    expect(screen.getByTestId('save-footer')).toHaveStyle({ backgroundColor: themes.dark.colors.surface });
  });

  test('My spending uses dark surfaces and the dark category colours', async () => {
    mockScheme = 'dark';
    markRefreshed();
    await insertConfirmedExpense(testDb.db, scope, { expenseId: 'a', purchaseDate: today, description: 'x', amountMinor: 1_000, category: 'Groceries' });
    await renderRouter('src/app');
    await fireEvent.press(await screen.findByTestId('tab-my-spending'));
    await screen.findByTestId('spending-results');

    expect(screen.getByTestId('my-spending-screen')).toHaveStyle({ backgroundColor: themes.dark.colors.background });
    expect(screen.getByTestId('breakdown-card')).toHaveStyle({ backgroundColor: themes.dark.colors.surface });
    expect(screen.getByTestId('bar-Groceries')).toHaveStyle({ backgroundColor: categoryColor('Groceries', 'dark') });
    expect(screen.getByTestId('period-total')).toHaveStyle({ color: themes.dark.colors.text });
  });
});
