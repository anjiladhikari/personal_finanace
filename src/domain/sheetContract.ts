/**
 * The user-visible spreadsheet contract. The app identifies its file by a
 * private Drive app property and its tab by numeric sheetId, never by name,
 * so users may rename either without breaking the connection.
 */

export const SPREADSHEET_NAME = 'My Expenses';
export const EXPENSES_TAB_TITLE = 'Expenses';
export const SPREADSHEET_MIME_TYPE = 'application/vnd.google-apps.spreadsheet';

/** Exact header row, columns A–E. */
export const EXPENSE_COLUMNS = ['Date', 'Description', 'Amount', 'Category', 'Expense ID'] as const;
export const HEADER_RANGE_COLUMNS = 'A1:E1';
/** Header plus first data row, used to check a tab is empty before writing. */
export const PROBE_RANGE_COLUMNS = 'A1:E2';

/**
 * Private Drive appProperties (visible only to this app's OAuth project).
 * FILE_ROLE identifies the file; TAB_ID records the Expenses tab's sheetId so
 * a renamed tab is still found after reinstall.
 */
export const APP_PROPERTY_FILE_ROLE = 'expenseTrackerRole';
export const APP_PROPERTY_FILE_ROLE_VALUE = 'expenses';
export const APP_PROPERTY_SCHEMA = 'expenseTrackerSchema';
export const APP_PROPERTY_SCHEMA_VALUE = '1';
export const APP_PROPERTY_TAB_ID = 'expenseTrackerTabId';

export function initialAppProperties(): Record<string, string> {
  return {
    [APP_PROPERTY_FILE_ROLE]: APP_PROPERTY_FILE_ROLE_VALUE,
    [APP_PROPERTY_SCHEMA]: APP_PROPERTY_SCHEMA_VALUE,
  };
}

export function isTaggedExpensesFile(appProperties: Readonly<Record<string, string>> | undefined): boolean {
  return appProperties?.[APP_PROPERTY_FILE_ROLE] === APP_PROPERTY_FILE_ROLE_VALUE;
}

export function taggedTabId(appProperties: Readonly<Record<string, string>> | undefined): number | null {
  const raw = appProperties?.[APP_PROPERTY_TAB_ID];
  if (raw === undefined || !/^\d{1,10}$/.test(raw)) return null;
  return Number(raw);
}

export interface SheetTab {
  readonly sheetId: number;
  readonly title: string;
  readonly index: number;
}

export type TabMatch = 'bound_id' | 'tagged_id' | 'title';

export type TabChoice =
  | { readonly kind: 'existing'; readonly tab: SheetTab; readonly matchedBy: TabMatch }
  /** No Expenses tab. If the file has a single tab, it may be reused when empty. */
  | { readonly kind: 'none'; readonly onlyTab: SheetTab | null };

/**
 * Finds the Expenses tab: first by the sheetId this phone stored, then by the
 * sheetId recorded in Drive app properties, then by title.
 */
export function chooseExpensesTab(
  tabs: readonly SheetTab[],
  ids: { readonly boundSheetId: number | null; readonly taggedSheetId: number | null },
): TabChoice {
  const byId = (id: number | null) => (id === null ? undefined : tabs.find((t) => t.sheetId === id));
  const bound = byId(ids.boundSheetId);
  if (bound) return { kind: 'existing', tab: bound, matchedBy: 'bound_id' };
  const tagged = byId(ids.taggedSheetId);
  if (tagged) return { kind: 'existing', tab: tagged, matchedBy: 'tagged_id' };
  const titled = tabs.find((t) => t.title === EXPENSES_TAB_TITLE);
  if (titled) return { kind: 'existing', tab: titled, matchedBy: 'title' };
  return { kind: 'none', onlyTab: tabs.length === 1 ? (tabs[0] ?? null) : null };
}

export type HeaderProblem = 'header_mismatch' | 'data_without_header';

export type TabInspection =
  | { readonly kind: 'ready' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'invalid'; readonly problem: HeaderProblem };

function isBlankRow(row: readonly unknown[] | undefined): boolean {
  return row === undefined || row.every((cell) => cell === null || String(cell).trim() === '');
}

/**
 * Decides what may be done with a tab, given the values of A1:E2.
 * Writing is only allowed into a completely empty tab, so existing rows are
 * never overwritten or relabelled.
 */
export function inspectExpensesTab(probe: readonly (readonly unknown[])[]): TabInspection {
  const [header, firstRow] = probe;
  if (isBlankRow(header)) {
    return isBlankRow(firstRow) ? { kind: 'empty' } : { kind: 'invalid', problem: 'data_without_header' };
  }
  const cells = EXPENSE_COLUMNS.map((_, i) => String(header?.[i] ?? '').trim());
  const matches = cells.every((cell, i) => cell === EXPENSE_COLUMNS[i]);
  return matches ? { kind: 'ready' } : { kind: 'invalid', problem: 'header_mismatch' };
}

// ---------------------------------------------------------------------------
// Yearly expense tabs. Each expense is written to the tab named after the
// year of its purchase date ("2026"), never the day it is saved or synced.
// Every yearly tab has the EXPENSE_COLUMNS header in row 1. The original
// "Expenses" tab is no longer read or written.

const YEAR_TITLE = /^\d{4}$/;

/** The yearly tab an expense belongs to, from its purchase date ("2026-11-20" → "2026"). */
export function yearTabTitle(purchaseDate: string): string {
  return purchaseDate.slice(0, 4);
}

export function isYearTabTitle(title: string): boolean {
  return YEAR_TITLE.test(title);
}

/** Sorts rows 2 onwards of a yearly tab by Date, moving whole rows (columns A–E). */
export const EXPENSE_SORT_COLUMNS = { startColumnIndex: 0, endColumnIndex: EXPENSE_COLUMNS.length } as const;

// ---------------------------------------------------------------------------
// Categories tab: a backup of the user's own category definitions, so they
// come back after a reinstall. Found by the sheetId in a Drive app property.

export const CATEGORIES_TAB_TITLE = 'Categories';
export const CATEGORY_COLUMNS = ['Category ID', 'Name', 'Icon', 'Colour', 'Created at'] as const;
export const APP_PROPERTY_CATEGORIES_TAB_ID = 'expenseTrackerCategoriesTabId';

export function taggedCategoriesTabId(appProperties: Readonly<Record<string, string>> | undefined): number | null {
  const raw = appProperties?.[APP_PROPERTY_CATEGORIES_TAB_ID];
  if (raw === undefined || !/^\d{1,10}$/.test(raw)) return null;
  return Number(raw);
}

/** Same rules as the Expenses tab: write a header only into an empty tab; never relabel data. */
export function inspectCategoriesTab(probe: readonly (readonly unknown[])[]): TabInspection {
  const [header, firstRow] = probe;
  if (isBlankRow(header)) {
    return isBlankRow(firstRow) ? { kind: 'empty' } : { kind: 'invalid', problem: 'data_without_header' };
  }
  const matches = CATEGORY_COLUMNS.every((column, i) => String(header?.[i] ?? '').trim() === column);
  return matches ? { kind: 'ready' } : { kind: 'invalid', problem: 'header_mismatch' };
}

/** A1 notation for a range inside a tab, quoting the title safely. */
export function a1Range(tabTitle: string, cells: string): string {
  return `'${tabTitle.replaceAll("'", "''")}'!${cells}`;
}
