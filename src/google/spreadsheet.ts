import {
  a1Range,
  APP_PROPERTY_TAB_ID,
  chooseExpensesTab,
  EXPENSE_COLUMNS,
  EXPENSES_TAB_TITLE,
  HEADER_RANGE_COLUMNS,
  inspectExpensesTab,
  PROBE_RANGE_COLUMNS,
  taggedTabId,
  type HeaderProblem,
  type SheetTab,
} from '@/domain/sheetContract';

import { setAppProperties, type DriveFile } from './drive';
import { GoogleApiError } from './http';
import type { GoogleSession } from './session';
import { batchUpdate, getTabs, getValues, updateValues } from './sheets';

export type TabSetupResult =
  | { readonly kind: 'ready'; readonly sheetId: number; readonly tabTitle: string }
  | { readonly kind: 'invalid'; readonly problem: HeaderProblem };

async function probe(session: GoogleSession, spreadsheetId: string, tab: SheetTab) {
  return inspectExpensesTab(await getValues(session, spreadsheetId, a1Range(tab.title, PROBE_RANGE_COLUMNS)));
}

async function addExpensesTab(session: GoogleSession, spreadsheetId: string): Promise<SheetTab> {
  const result = await batchUpdate(session, spreadsheetId, [
    { addSheet: { properties: { title: EXPENSES_TAB_TITLE, gridProperties: { frozenRowCount: 1 } } } },
  ]);
  const properties = result.replies?.[0]?.addSheet?.properties;
  if (typeof properties?.sheetId !== 'number') throw new GoogleApiError('invalid_response', 200, null);
  return {
    sheetId: properties.sheetId,
    title: EXPENSES_TAB_TITLE,
    index: typeof properties.index === 'number' ? properties.index : 0,
  };
}

/**
 * Makes sure the spreadsheet has a valid Expenses tab, creating or
 * initialising it only where that cannot disturb existing data. Every step
 * re-checks the live sheet, so an interrupted run is simply repeated.
 *
 * Writes happen only to an empty tab: existing rows are never overwritten,
 * and a tab whose header differs from the contract is reported, not fixed.
 */
export async function ensureExpensesTab(
  session: GoogleSession,
  file: DriveFile,
  boundSheetId: number | null,
): Promise<TabSetupResult> {
  const tabs = await getTabs(session, file.id);
  const choice = chooseExpensesTab(tabs, { boundSheetId, taggedSheetId: taggedTabId(file.appProperties) });

  let tab: SheetTab;
  if (choice.kind === 'existing') {
    tab = choice.tab;
  } else if (choice.onlyTab !== null && (await probe(session, file.id, choice.onlyTab)).kind === 'empty') {
    // A new file's default empty tab ("Sheet1" or its localized name) becomes Expenses.
    await batchUpdate(session, file.id, [
      {
        updateSheetProperties: {
          properties: { sheetId: choice.onlyTab.sheetId, title: EXPENSES_TAB_TITLE, gridProperties: { frozenRowCount: 1 } },
          fields: 'title,gridProperties.frozenRowCount',
        },
      },
    ]);
    tab = { ...choice.onlyTab, title: EXPENSES_TAB_TITLE };
  } else {
    tab = await addExpensesTab(session, file.id);
  }

  const inspection = await probe(session, file.id, tab);
  if (inspection.kind === 'invalid') return { kind: 'invalid', problem: inspection.problem };
  if (inspection.kind === 'empty') {
    await updateValues(session, file.id, a1Range(tab.title, HEADER_RANGE_COLUMNS), [[...EXPENSE_COLUMNS]]);
  }

  if (taggedTabId(file.appProperties) !== tab.sheetId) {
    await setAppProperties(session, file.id, { [APP_PROPERTY_TAB_ID]: String(tab.sheetId) });
  }
  return { kind: 'ready', sheetId: tab.sheetId, tabTitle: tab.title };
}
