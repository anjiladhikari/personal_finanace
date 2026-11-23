import { act, fireEvent, renderHook, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import type React from 'react';

import { FakeAuthorizer, FakeGoogle } from '../test/fakeGoogle';
import { openTestDatabase, type TestDatabase } from '../test/sqliteTestDatabase';

import { sumConfirmedSpending } from '@/db/confirmedExpenses';
import { DatabaseContext } from '@/db/DatabaseContext';
import { migrateDatabase } from '@/db/migrations';
import { listPendingSubmissions } from '@/db/pendingSubmissions';
import type { SqlDatabase } from '@/db/sql';
import { todayLocalDate } from '@/domain/dates';
import type { DataScope } from '@/domain/expense';
import { GoogleServicesProvider } from '@/google/GoogleServicesContext';
import type { GoogleServices } from '@/google/services';
import { connectGoogle } from '@/sync/connection';
import { SubmissionEngineProvider } from '@/sync/SubmissionEngineContext';
import { useExpenseForm } from '@/ui/useExpenseForm';

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
let mockIdCounter = 0;
jest.mock('@/sync/platform', () => ({
  createPlatformServices: () => ({
    isOnline: async () => mockOnline,
    onConnectivityRegained: () => () => undefined,
    newId: () => `uuid-${(mockIdCounter += 1)}`,
    now: () => Date.now(),
  }),
}));

const ALICE = 'sub-alice';
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
  mockIdCounter = 0;
});

afterEach(() => {
  testDb.close();
  mockDatabase = null;
  mockServices = null;
});

const rows = () => google.dataRows(scope.spreadsheetId);
const appends = () => google.requests('POST', ':append');

async function fillValidExpense(description = 'Coffee', amount = '4.50') {
  await fireEvent.changeText(await screen.findByLabelText('Amount in AUD'), amount);
  await fireEvent.changeText(screen.getByLabelText('Description'), description);
  await fireEvent.press(screen.getByTestId('category-Eating out'));
}

describe('form', () => {
  test('has labelled fields, a decimal keypad, the seven categories and today as the default date', async () => {
    await renderRouter('src/app');

    const amount = await screen.findByLabelText('Amount in AUD');
    expect(amount).toHaveProp('keyboardType', 'decimal-pad');
    expect(screen.getByLabelText('Description')).toBeOnTheScreen();
    for (const category of ['Groceries', 'Eating out', 'Transport', 'Bills', 'Shopping', 'Health', 'Other']) {
      expect(screen.getByRole('radio', { name: category })).toBeOnTheScreen();
    }
    expect(screen.getByTestId('date-button')).toHaveTextContent(`Today (${todayLocalDate()})`);
    expect(screen.getAllByRole('button', { name: 'Save expense' })).toHaveLength(1);
  });

  test('shows inline validation and saves nothing until the draft is valid', async () => {
    await renderRouter('src/app');

    await fireEvent.press(await screen.findByTestId('save-expense'));

    expect(screen.getByTestId('amount-error')).toHaveTextContent('Enter an amount.');
    expect(screen.getByTestId('description-error')).toHaveTextContent('Enter a description.');
    expect(screen.getByTestId('category-error')).toHaveTextContent('Choose a category.');
    expect(await listPendingSubmissions(testDb.db, scope)).toEqual([]);

    await fireEvent.changeText(screen.getByLabelText('Amount in AUD'), '12.345');
    expect(screen.getByTestId('amount-error')).toHaveTextContent('Use at most 2 decimal places.');
    await fireEvent.changeText(screen.getByLabelText('Amount in AUD'), '12.34');
    expect(screen.queryByTestId('amount-error')).toBeNull();

    await fireEvent.changeText(screen.getByLabelText('Description'), '   ');
    expect(screen.getByTestId('description-error')).toHaveTextContent('Enter a description.');
    expect(appends()).toHaveLength(0);
  });

  test('saves, confirms with Google, then resets the form', async () => {
    await renderRouter('src/app');
    await fillValidExpense('  Coffee  ');

    await fireEvent.press(screen.getByTestId('save-expense'));

    expect(await screen.findByText('Saved to Google Sheets.')).toBeOnTheScreen();
    expect(rows()).toEqual([[todayLocalDate(), 'Coffee', 4.5, 'Eating out', 'uuid-1']]);
    expect(screen.getByLabelText('Amount in AUD')).toHaveProp('value', '');
    expect(screen.getByLabelText('Description')).toHaveProp('value', '');
    expect(screen.getByRole('radio', { name: 'Eating out' })).not.toBeChecked();
    expect(await sumConfirmedSpending(testDb.db, scope, null)).toBe(450);
  });

  test('a second tap while the first save is in flight does not save twice', async () => {
    const slow: GoogleServices = {
      authorizer: mockServices!.authorizer,
      fetch: async (url, init) => {
        if (url.includes(':append')) await new Promise((resolve) => setTimeout(resolve, 30));
        return google.fetch(url, init);
      },
    };
    mockServices = slow;
    await renderRouter('src/app');
    await fillValidExpense();

    await fireEvent.press(screen.getByTestId('save-expense'));
    expect(screen.getByTestId('save-expense')).toHaveTextContent('Saving…');
    await fireEvent.press(screen.getByTestId('save-expense'));

    expect(await screen.findByText('Saved to Google Sheets.')).toBeOnTheScreen();
    expect(rows()).toHaveLength(1);
    expect(appends()).toHaveLength(1);
    expect(mockIdCounter).toBe(1);
  });

  test('two taps in the same instant create one submission', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <DatabaseContext.Provider value={testDb.db}>
        <GoogleServicesProvider>
          <SubmissionEngineProvider>{children}</SubmissionEngineProvider>
        </GoogleServicesProvider>
      </DatabaseContext.Provider>
    );
    const { result } = await renderHook(() => useExpenseForm(2), { wrapper });
    await act(async () => {
      result.current.update({ description: 'Coffee', amountText: '4.50', category: 'Eating out' });
    });

    await act(async () => {
      void result.current.save();
      void result.current.save();
    });

    await waitFor(() => expect(result.current.notice).toBe('saved'));
    expect(rows()).toHaveLength(1);
    expect(mockIdCounter).toBe(1);
  });
});

describe('offline', () => {
  test('keeps the draft visible and locked, lists it as unresolved, and confirms it later without a duplicate', async () => {
    mockOnline = false;
    await renderRouter('src/app');
    await fillValidExpense();

    await fireEvent.press(screen.getByTestId('save-expense'));

    expect(await screen.findByText('Saved on this phone, not yet in Google Sheets')).toBeOnTheScreen();
    expect(screen.getByLabelText('Description')).toHaveProp('value', 'Coffee');
    expect(screen.getByLabelText('Description')).toHaveProp('editable', false);
    expect(within_unresolved()).toHaveTextContent(/Coffee · \$4\.50/);
    expect(within_unresolved()).toHaveTextContent(/Waiting for an internet connection\./);
    expect(await sumConfirmedSpending(testDb.db, scope, null)).toBe(0);
    expect(appends()).toHaveLength(0);

    // Tapping Save again retries the same submission; it never creates a second one.
    await fireEvent.press(screen.getByTestId('save-expense'));
    expect(await screen.findByTestId('unresolved-banner')).toBeOnTheScreen();
    expect(await listPendingSubmissions(testDb.db, scope)).toHaveLength(1);

    mockOnline = true;
    await fireEvent.press(screen.getByTestId('save-expense'));

    expect(await screen.findByText('Saved to Google Sheets.')).toBeOnTheScreen();
    expect(rows().map((r) => r[4])).toEqual(['uuid-1']);
    expect(screen.getByLabelText('Description')).toHaveProp('value', '');
    expect(screen.queryByTestId('unresolved-list')).toBeNull();
  });

  test('New expense starts a fresh form while the unsent one stays listed', async () => {
    mockOnline = false;
    await renderRouter('src/app');
    await fillValidExpense();
    await fireEvent.press(screen.getByTestId('save-expense'));
    await screen.findByTestId('unresolved-banner');

    await fireEvent.press(screen.getByTestId('new-expense'));

    expect(screen.getByLabelText('Description')).toHaveProp('value', '');
    expect(screen.getByLabelText('Description')).toHaveProp('editable', true);
    expect(screen.getByTestId('unresolved-uuid-1')).toBeOnTheScreen();

    mockOnline = true;
    await fireEvent.press(screen.getByTestId('retry-now'));
    await waitFor(() => expect(screen.queryByTestId('unresolved-list')).toBeNull());
    expect(rows()).toHaveLength(1);
  });
});

function within_unresolved() {
  return screen.getByTestId('unresolved-uuid-1');
}
