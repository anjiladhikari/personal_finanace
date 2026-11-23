import {
  a1Range,
  chooseExpensesTab,
  EXPENSE_COLUMNS,
  inspectExpensesTab,
  isTaggedExpensesFile,
  taggedTabId,
  type SheetTab,
} from './sheetContract';

const tab = (sheetId: number, title: string, index = 0): SheetTab => ({ sheetId, title, index });

describe('contract', () => {
  test('column order is exactly Date | Description | Amount | Category | Expense ID', () => {
    expect(EXPENSE_COLUMNS).toEqual(['Date', 'Description', 'Amount', 'Category', 'Expense ID']);
  });

  test('file tag and tab id parsing', () => {
    expect(isTaggedExpensesFile({ expenseTrackerRole: 'expenses' })).toBe(true);
    expect(isTaggedExpensesFile({ expenseTrackerRole: 'other' })).toBe(false);
    expect(isTaggedExpensesFile(undefined)).toBe(false);
    expect(taggedTabId({ expenseTrackerTabId: '1234' })).toBe(1234);
    expect(taggedTabId({ expenseTrackerTabId: '0' })).toBe(0);
    expect(taggedTabId({ expenseTrackerTabId: '-1' })).toBeNull();
    expect(taggedTabId({ expenseTrackerTabId: '12a' })).toBeNull();
    expect(taggedTabId({})).toBeNull();
  });

  test('A1 ranges quote tab titles, including apostrophes', () => {
    expect(a1Range('Expenses', 'A1:E2')).toBe("'Expenses'!A1:E2");
    expect(a1Range("Sam's costs", 'A1:E1')).toBe("'Sam''s costs'!A1:E1");
  });
});

describe('chooseExpensesTab', () => {
  const tabs = [tab(0, 'Sheet1'), tab(77, 'Expenses', 1), tab(42, 'Renamed', 2)];

  test('prefers the sheetId stored on this phone', () => {
    expect(chooseExpensesTab(tabs, { boundSheetId: 42, taggedSheetId: 0 })).toMatchObject({
      kind: 'existing',
      tab: { sheetId: 42 },
      matchedBy: 'bound_id',
    });
  });

  test('then the sheetId recorded in Drive, then the title', () => {
    expect(chooseExpensesTab(tabs, { boundSheetId: 999, taggedSheetId: 42 })).toMatchObject({
      tab: { sheetId: 42 },
      matchedBy: 'tagged_id',
    });
    expect(chooseExpensesTab(tabs, { boundSheetId: null, taggedSheetId: null })).toMatchObject({
      tab: { sheetId: 77 },
      matchedBy: 'title',
    });
  });

  test('reports the single tab of a new file as reusable, otherwise none', () => {
    expect(chooseExpensesTab([tab(0, 'Sheet1')], { boundSheetId: null, taggedSheetId: null })).toEqual({
      kind: 'none',
      onlyTab: tab(0, 'Sheet1'),
    });
    expect(chooseExpensesTab([tab(0, 'A'), tab(1, 'B')], { boundSheetId: null, taggedSheetId: null })).toEqual({
      kind: 'none',
      onlyTab: null,
    });
  });
});

describe('inspectExpensesTab', () => {
  const header = [...EXPENSE_COLUMNS];

  test.each([
    ['exact header', [header], 'ready'],
    ['header plus data', [header, ['2026-11-22', 'Bus', 3.8, 'Transport', 'x']], 'ready'],
    ['header with surrounding spaces', [[' Date ', 'Description', 'Amount', 'Category', 'Expense ID']], 'ready'],
    ['empty tab', [], 'empty'],
    ['blank cells only', [['', '  '], []], 'empty'],
  ])('%s → %s', (_label, probe, kind) => {
    expect(inspectExpensesTab(probe).kind).toBe(kind);
  });

  test.each([
    ['renamed column', [['Date', 'Description', 'Cost', 'Category', 'Expense ID']], 'header_mismatch'],
    ['reordered columns', [['Description', 'Date', 'Amount', 'Category', 'Expense ID']], 'header_mismatch'],
    ['missing column', [['Date', 'Description', 'Amount', 'Category']], 'header_mismatch'],
    ['wrong case', [['date', 'description', 'amount', 'category', 'expense id']], 'header_mismatch'],
    ['data in row 1', [['2026-11-22', 'Bus', 3.8, 'Transport', 'x']], 'header_mismatch'],
    ['data below an empty row 1', [[], ['2026-11-22', 'Bus']], 'data_without_header'],
  ])('%s → invalid (%s)', (_label, probe, problem) => {
    expect(inspectExpensesTab(probe)).toEqual({ kind: 'invalid', problem });
  });
});
