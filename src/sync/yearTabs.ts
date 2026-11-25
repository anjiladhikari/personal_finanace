import {
  a1Range,
  EXPENSE_COLUMNS,
  EXPENSE_SORT_COLUMNS,
  HEADER_RANGE_COLUMNS,
  inspectExpensesTab,
  isYearTabTitle,
  PROBE_RANGE_COLUMNS,
} from '@/domain/sheetContract';
import { GoogleApiError } from '@/google/http';
import type { GoogleSession } from '@/google/session';
import { batchUpdate, getTabs, getValues, updateValues, type TabWithSize } from '@/google/sheets';

/** A yearly tab whose header has been checked (or just written). */
export interface YearTab {
  readonly sheetId: number;
  readonly title: string;
  /** Rows in the grid (upper bound for reading), when known. */
  readonly rowCount: number | null;
}

/** A tab named after the year whose row 1 is not the expense header: never written to or read. */
export class YearTabChangedError extends Error {
  constructor(readonly title: string) {
    super('A yearly tab has an unexpected header');
    this.name = 'YearTabChangedError';
  }
}

async function inspect(session: GoogleSession, spreadsheetId: string, title: string) {
  return inspectExpensesTab(await getValues(session, spreadsheetId, a1Range(title, PROBE_RANGE_COLUMNS)));
}

async function writeHeader(session: GoogleSession, spreadsheetId: string, title: string): Promise<void> {
  await updateValues(session, spreadsheetId, a1Range(title, HEADER_RANGE_COLUMNS), [[...EXPENSE_COLUMNS]]);
}

const toYearTab = (tab: TabWithSize): YearTab => ({ sheetId: tab.sheetId, title: tab.title, rowCount: tab.rowCount });

/**
 * The tab for `title` (a year such as "2026"), ready to append to. An
 * existing tab is reused if its header is right (an empty one gets the
 * header); a missing one is created with the header and a frozen first row.
 * If another write created it in the meantime, that tab is used rather than
 * a second one. A tab with any other header is refused (YearTabChangedError).
 */
export async function ensureYearTab(session: GoogleSession, spreadsheetId: string, title: string): Promise<YearTab> {
  if (!isYearTabTitle(title)) throw new Error('Not a year');
  const existing = (await getTabs(session, spreadsheetId)).find((t) => t.title === title);
  if (existing !== undefined) {
    const state = await inspect(session, spreadsheetId, title);
    if (state.kind === 'invalid') throw new YearTabChangedError(title);
    if (state.kind === 'empty') await writeHeader(session, spreadsheetId, title);
    return toYearTab(existing);
  }

  let sheetId: number | undefined;
  try {
    const reply = await batchUpdate(session, spreadsheetId, [
      { addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } },
    ]);
    const id = reply.replies?.[0]?.addSheet?.properties?.sheetId;
    sheetId = typeof id === 'number' ? id : undefined;
  } catch (error) {
    // Sheets refuses a duplicate title: someone else created it just now. Use theirs.
    if (!(error instanceof GoogleApiError && error.kind === 'bad_request')) throw error;
    const raced = (await getTabs(session, spreadsheetId)).find((t) => t.title === title);
    if (raced === undefined) throw error;
    return ensureYearTab(session, spreadsheetId, title);
  }
  if (sheetId === undefined) throw new Error('Sheets did not return the new tab');
  await writeHeader(session, spreadsheetId, title);
  return { sheetId, title, rowCount: null };
}

/**
 * Every yearly tab to read, oldest year first: titled as a year, with the
 * expense header (or still completely empty). The original "Expenses" tab
 * and any other tab are not included. A year tab whose header was changed
 * stops the read (YearTabChangedError) rather than being skipped, so a
 * refresh never silently drops that year's expenses from the totals.
 */
export async function listYearTabs(session: GoogleSession, spreadsheetId: string): Promise<YearTab[]> {
  const candidates = (await getTabs(session, spreadsheetId))
    .filter((t) => isYearTabTitle(t.title))
    .sort((a, b) => (a.title < b.title ? -1 : 1));
  for (const tab of candidates) {
    if ((await inspect(session, spreadsheetId, tab.title)).kind === 'invalid') throw new YearTabChangedError(tab.title);
  }
  return candidates.map(toYearTab);
}

export type SortOutcome = 'sorted' | 'missing' | 'changed';

/**
 * Sorts a yearly tab's expense rows by Date, newest first. Row 1 (the
 * header) stays put, and columns A–E move together, so every field of an
 * expense — its Expense ID included — stays on one row. Dates are written as
 * YYYY-MM-DD text, so text order is date order.
 */
export async function sortYearTab(session: GoogleSession, spreadsheetId: string, title: string): Promise<SortOutcome> {
  const tab = (await getTabs(session, spreadsheetId)).find((t) => t.title === title);
  if (tab === undefined) return 'missing';
  if ((await inspect(session, spreadsheetId, title)).kind === 'invalid') return 'changed';
  await batchUpdate(session, spreadsheetId, [
    {
      sortRange: {
        range: { sheetId: tab.sheetId, startRowIndex: 1, ...EXPENSE_SORT_COLUMNS },
        sortSpecs: [{ dimensionIndex: 0, sortOrder: 'DESCENDING' }],
      },
    },
  ]);
  return 'sorted';
}
