import { act, fireEvent, renderRouter, screen, within } from 'expo-router/testing-library';
import { DeviceEventEmitter, Dimensions, StyleSheet } from 'react-native';

import { FakeAuthorizer, FakeGoogle } from '../test/fakeGoogle';
import { openTestDatabase, type TestDatabase } from '../test/sqliteTestDatabase';

import { insertCustomCategory } from '@/db/categories';
import { notifySubmissionsChanged } from '@/db/changes';
import { insertConfirmedExpense } from '@/db/confirmedExpenses';
import { migrateDatabase } from '@/db/migrations';
import { insertPendingSubmission, listPendingSubmissions } from '@/db/pendingSubmissions';
import type { SqlDatabase } from '@/db/sql';
import { addDays, todayLocalDate } from '@/domain/dates';
import type { DataScope } from '@/domain/expense';
import type { GoogleServices } from '@/google/services';
import { connectGoogle } from '@/sync/connection';
import { categoryColor, colourHex } from '@/ui/categoryColors';
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

let mockOnline = true;
let mockIds = 0;
jest.mock('@/sync/platform', () => ({
  createPlatformServices: () => ({
    isOnline: async () => mockOnline,
    onConnectivityRegained: () => () => undefined,
    newId: () => `uuid-${(mockIds += 1)}`,
    now: () => Date.now(),
  }),
}));

const ALICE = 'sub-alice';
const DEFAULT_WINDOW = Dimensions.get('window');
const today = todayLocalDate();

let testDb: TestDatabase;
let google: FakeGoogle;
let scope: DataScope;
let n = 0;

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
  mockIds = 0;
  mockScheme = 'light';
  n = 0;
  testDb.raw.prepare("UPDATE app_settings SET last_successful_sync_at = '2026-11-20T09:30:00.000Z' WHERE id = 1").run();
  google.log.length = 0;
});

afterEach(() => {
  testDb.close();
  mockDatabase = null;
  mockServices = null;
  Dimensions.set({ window: DEFAULT_WINDOW, screen: DEFAULT_WINDOW });
});

async function spent(category: string, times = 1, amountMinor = 1_000, date = today) {
  for (let i = 0; i < times; i += 1) {
    n += 1;
    await insertConfirmedExpense(testDb.db, scope, { expenseId: `e${n}`, purchaseDate: date, description: 'x', amountMinor, category });
  }
}

async function customCategory(name: string, colour: 'red' | 'blue' = 'red') {
  await insertCustomCategory(testDb.db, ALICE, { id: `custom-${name}`, name, icon: 'tag', colour, createdAt: '2026-11-01T00:00:00.000Z' });
}

/** Names on the quick-access chips, in screen order. */
function quickChips(): string[] {
  return within(screen.getByTestId('quick-categories'))
    .getAllByTestId(/^category-/)
    .map((chip) => String(chip.props.testID).slice('category-'.length))
    .filter((name) => name !== 'see-more');
}

const pickerRows = () => within(screen.getByTestId('category-list')).getAllByTestId(/^picker-category-/).map((row) => String(row.props.testID).slice(16));

async function openAddExpense() {
  await renderRouter('src/app');
  await screen.findByTestId('quick-categories');
}

async function fillDraft() {
  await fireEvent.changeText(screen.getByLabelText('Amount in AUD'), '18.20');
  await fireEvent.changeText(screen.getByLabelText('Description'), 'Swim lesson');
}

function expectDraftKept() {
  expect(screen.getByLabelText('Amount in AUD')).toHaveProp('value', '18.20');
  expect(screen.getByLabelText('Description')).toHaveProp('value', 'Swim lesson');
}

describe('quick-access chips', () => {
  test('before any history: the six defaults, then "See more"', async () => {
    await openAddExpense();
    expect(quickChips()).toEqual(['Groceries', 'Eating out', 'Transport', 'Bills', 'Shopping', 'Health']);
    expect(screen.getByRole('button', { name: 'See more categories' })).toBeOnTheScreen();
  });

  test('the most used in the last 90 days by count (pending and custom included), topped up with the defaults', async () => {
    await customCategory('Kids');
    await spent('Fuel', 3, 100);
    await spent('Pets', 2, 1_000_000);
    await spent('Taxes', 5, 100, addDays(today, -95)); // outside the window
    await insertPendingSubmission(testDb.db, scope, {
      submissionId: 'p1',
      createdAt: '2026-11-25T00:00:00.000Z',
      purchaseDate: today,
      description: 'x',
      amountMinor: 100,
      category: 'Kids',
    });

    await openAddExpense();

    expect(quickChips()).toEqual(['Fuel', 'Pets', 'Kids', 'Groceries', 'Eating out', 'Transport']);
  });

  test('the order stays put while an expense is being entered, and updates for the next one', async () => {
    await spent('Fuel', 2);
    await openAddExpense();
    expect(quickChips()[0]).toBe('Fuel');

    await fillDraft();
    await spent('Pets', 5);
    await act(async () => notifySubmissionsChanged());
    expect(quickChips()[0]).toBe('Fuel');

    await fireEvent.press(screen.getByTestId('category-Fuel'));
    await fireEvent.press(screen.getByTestId('save-expense'));
    await screen.findByTestId('save-confirmation');
    expect(quickChips().slice(0, 2)).toEqual(['Pets', 'Fuel']);
  });

  test('a narrow phone with the largest text shows fewer chips, never shrinks them, and keeps "See more"', async () => {
    const narrow = { width: 320, height: 640, scale: 2, fontScale: 2 };
    Dimensions.set({ window: narrow, screen: narrow });
    await openAddExpense();

    const shown = quickChips();
    expect(shown.length).toBeGreaterThanOrEqual(1);
    expect(shown.length).toBeLessThan(6);
    expect(shown).toEqual(['Groceries', 'Eating out', 'Transport', 'Bills', 'Shopping', 'Health'].slice(0, shown.length));
    expect(screen.getByTestId('category-see-more')).toBeOnTheScreen();
    expect(StyleSheet.flatten(screen.getByTestId('category-Groceries').props.style)).toMatchObject({ minHeight: 44 });
  });
});

describe('"See more" picker', () => {
  test('opens over the form without growing the category section; Back closes it and keeps the draft', async () => {
    await openAddExpense();
    await fillDraft();
    const before = quickChips();

    await fireEvent.press(screen.getByTestId('category-see-more'));
    const picker = screen.getByTestId('category-picker');
    expect(picker).toBeOnTheScreen();
    expect(within(picker).getByTestId('category-search')).toBeOnTheScreen();
    expect(within(picker).getByTestId('add-category')).toBeOnTheScreen();
    expect(quickChips()).toEqual(before);

    await fireEvent(picker, 'requestClose'); // Android Back
    expect(screen.queryByTestId('category-picker')).toBeNull();
    expectDraftKept();

    await fireEvent.press(screen.getByTestId('category-see-more'));
    // Tap outside the sheet. (Jest renders as iOS, where the modal sheet hides its backdrop from queries.)
    await fireEvent.press(screen.getByTestId('picker-backdrop', { includeHiddenElements: true }));
    expect(screen.queryByTestId('category-picker')).toBeNull();
    expectDraftKept();
  });

  test('lists every category alphabetically with Other last, custom ones included, selection marked', async () => {
    await customCategory('Kids');
    await spent('Typed in Sheets', 1, 100, addDays(today, -400));
    await openAddExpense();
    await fireEvent.press(screen.getByTestId('category-Bills'));
    await fireEvent.press(screen.getByTestId('category-see-more'));

    const rows = pickerRows();
    expect(rows[0]).toBe('Bills');
    expect(rows.at(-1)).toBe('Other');
    expect(rows).toEqual(expect.arrayContaining(['Kids', 'Typed in Sheets', 'Rent & mortgage', 'Work expenses']));
    expect(rows).toHaveLength(26 + 2);
    expect(screen.getByTestId('picker-category-Bills')).toBeChecked();
    expect(screen.getByTestId('picker-category-Kids')).not.toBeChecked();
  });

  test('search ignores case, finds custom categories, and says when nothing matches', async () => {
    await customCategory('Kids’ swimming');
    await openAddExpense();
    await fireEvent.press(screen.getByTestId('category-see-more'));

    await fireEvent.changeText(screen.getByTestId('category-search'), 'SWIM');
    expect(pickerRows()).toEqual(['Kids’ swimming']);
    await fireEvent.changeText(screen.getByTestId('category-search'), 'gRoC');
    expect(pickerRows()).toEqual(['Groceries']);
    await fireEvent.changeText(screen.getByTestId('category-search'), 'zzz');
    expect(screen.getByTestId('picker-empty')).toHaveTextContent(/^No categories match “zzz”\./);
    expect(screen.getByTestId('add-category')).toBeOnTheScreen();
  });

  test('choosing a category closes the sheet, selects it, and swaps it in for the last chip', async () => {
    await openAddExpense();
    await fillDraft();
    const before = quickChips();

    await fireEvent.press(screen.getByTestId('category-see-more'));
    await fireEvent.press(screen.getByTestId('picker-category-Pets'));

    expect(screen.queryByTestId('category-picker')).toBeNull();
    const after = quickChips();
    expect(after).toHaveLength(before.length);
    expect(after).toEqual([...before.slice(0, -1), 'Pets']);
    expect(screen.getByRole('radio', { name: 'Pets' })).toBeChecked();
    expectDraftKept();

    await fireEvent.press(screen.getByTestId('save-expense'));
    await screen.findByTestId('save-confirmation');
    expect(google.dataRows(scope.spreadsheetId)).toEqual([[today, 'Swim lesson', 18.2, 'Pets', 'uuid-1']]);
  });
});

describe('adding a category', () => {
  async function openCreate() {
    await fireEvent.press(screen.getByTestId('category-see-more'));
    await fireEvent.press(screen.getByTestId('add-category'));
  }

  test('blank names and duplicates are refused; an existing one can be selected instead', async () => {
    await openAddExpense();
    await fillDraft();
    await openCreate();

    await fireEvent.press(screen.getByTestId('create-category'));
    expect(screen.getByTestId('new-category-problem')).toHaveTextContent('Enter a name for the category.');

    await fireEvent.changeText(screen.getByTestId('new-category-name'), '  groceries ');
    await fireEvent.press(screen.getByTestId('create-category'));
    expect(screen.getByTestId('new-category-problem')).toHaveTextContent(/^“Groceries” already exists\./);

    await fireEvent.press(screen.getByTestId('select-existing-category'));
    expect(screen.queryByTestId('category-picker')).toBeNull();
    expect(screen.getByRole('radio', { name: 'Groceries' })).toBeChecked();
    expectDraftKept();
  });

  test('names are limited to 30 characters; Cancel goes back to the list', async () => {
    await openAddExpense();
    await openCreate();
    expect(screen.getByTestId('new-category-name').props.maxLength).toBe(30);
    await fireEvent.press(screen.getByTestId('cancel-create-category'));
    expect(screen.getByTestId('category-search')).toBeOnTheScreen();
  });

  test('offline: "Create & select" makes the category and selects it, without saving the expense', async () => {
    mockOnline = false;
    await openAddExpense();
    await fillDraft();
    await openCreate();
    await fireEvent.changeText(screen.getByTestId('new-category-name'), '  Kids’   swimming ');

    await fireEvent.press(screen.getByTestId('create-category'));

    expect(await screen.findByRole('radio', { name: 'Kids’ swimming' })).toBeChecked();
    expect(screen.queryByTestId('category-picker')).toBeNull();
    expectDraftKept();
    expect(await listPendingSubmissions(testDb.db, scope)).toEqual([]);
    expect(google.requests('POST', ':append')).toEqual([]);
    expect(testDb.raw.prepare('SELECT name, synced_spreadsheet_id FROM categories').all()).toEqual([
      { name: 'Kids’ swimming', synced_spreadsheet_id: null },
    ]);

    // Search starts the name: "+ Add category" from an empty search carries the text over.
    await fireEvent.press(screen.getByTestId('category-see-more'));
    await fireEvent.changeText(screen.getByTestId('category-search'), 'dog walking');
    await fireEvent.press(screen.getByTestId('add-category'));
    expect(screen.getByTestId('new-category-name')).toHaveProp('value', 'dog walking');
  });
});

describe('appearance', () => {
  test('the sheet takes about two thirds of the screen and uses the dark tokens in dark mode', async () => {
    mockScheme = 'dark';
    await openAddExpense();
    await fireEvent.press(screen.getByTestId('category-see-more'));

    const style = StyleSheet.flatten(screen.getByTestId('category-picker').props.style) as { height: number; backgroundColor: string };
    expect(style.backgroundColor).toBe(themes.dark.colors.surface);
    const height = Dimensions.get('window').height;
    expect(style.height / height).toBeGreaterThanOrEqual(0.65);
    expect(style.height / height).toBeLessThanOrEqual(0.7);
  });

  test('with the keyboard up, the sheet makes room so search and "+ Add category" stay reachable', async () => {
    await openAddExpense();
    await fireEvent.press(screen.getByTestId('category-see-more'));
    const area = screen.getByTestId('category-picker').parent;
    if (area === null) throw new Error('no keyboard area');

    await fireEvent(area, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 800 } }, persist: () => undefined });
    await act(async () => {
      DeviceEventEmitter.emit('keyboardWillShow', {
        startCoordinates: { screenX: 0, screenY: 800, width: 360, height: 0 },
        endCoordinates: { screenX: 0, screenY: 500, width: 360, height: 300 },
        duration: 0,
        easing: 'keyboard',
      });
    });

    expect(Number(StyleSheet.flatten(area.props.style).paddingBottom)).toBeGreaterThan(0);
    expect(within(screen.getByTestId('category-picker')).getByTestId('category-search')).toBeOnTheScreen();
    expect(within(screen.getByTestId('category-picker')).getByTestId('add-category')).toBeOnTheScreen();
  });
});

describe('charts', () => {
  test('new built-in and custom categories appear under their own names and colours, never as Other', async () => {
    await customCategory('Kids', 'red');
    await spent('Rent & mortgage', 1, 150_000);
    await spent('Kids', 2, 2_500);
    await spent('Typed in Sheets', 1, 1_000);
    await spent('Groceries', 1, 8_000);

    await renderRouter('src/app');
    await fireEvent.press(await screen.findByTestId('tab-my-spending'));
    await screen.findByTestId('spending-results');

    expect(screen.getByTestId('period-total')).toHaveTextContent('$1,640.00');
    expect(screen.getByTestId('bar-Kids')).toHaveStyle({ backgroundColor: colourHex('red', 'light') });
    expect(screen.getByTestId('bar-Rent & mortgage')).toHaveStyle({ backgroundColor: categoryColor('Rent & mortgage') });
    expect(screen.getByTestId('category-row-Typed in Sheets')).toHaveTextContent(/^Typed in Sheets\$10\.00 · /);
    expect(screen.getByTestId('category-row-Groceries')).toHaveTextContent(/^Groceries\$80\.00 · /);
    expect(screen.queryByTestId('category-row-Other')).toBeNull();

    await fireEvent.press(screen.getByTestId('chart-pie'));
    const breakdown = screen.getByTestId('pie-breakdown');
    for (const name of ['Rent & mortgage', 'Groceries', 'Kids', 'Typed in Sheets']) {
      expect(within(breakdown).getByTestId(`category-row-${name}`)).toBeOnTheScreen();
    }
  });
});
