import type { SheetTab } from '@/domain/sheetContract';

import { GoogleApiError } from './http';
import type { GoogleSession } from './session';

export const SHEETS_URL = 'https://sheets.googleapis.com/v4/spreadsheets';

function spreadsheetUrl(spreadsheetId: string): string {
  return `${SHEETS_URL}/${encodeURIComponent(spreadsheetId)}`;
}

export async function getTabs(session: GoogleSession, spreadsheetId: string): Promise<SheetTab[]> {
  const fields = encodeURIComponent('sheets.properties(sheetId,title,index)');
  const result = await session.request<{ sheets?: { properties?: Record<string, unknown> }[] }>({
    method: 'GET',
    url: `${spreadsheetUrl(spreadsheetId)}?fields=${fields}`,
  });
  return (result.sheets ?? []).map(({ properties = {} }) => {
    const { sheetId, title, index } = properties;
    if (typeof sheetId !== 'number' || typeof title !== 'string') {
      throw new GoogleApiError('invalid_response', 200, null);
    }
    return { sheetId, title, index: typeof index === 'number' ? index : 0 };
  });
}

/** Unformatted cell values for an A1 range; empty trailing cells are omitted by the API. */
export async function getValues(
  session: GoogleSession,
  spreadsheetId: string,
  range: string,
): Promise<unknown[][]> {
  const params = new URLSearchParams({ majorDimension: 'ROWS', valueRenderOption: 'UNFORMATTED_VALUE' });
  const result = await session.request<{ values?: unknown[][] }>({
    method: 'GET',
    url: `${spreadsheetUrl(spreadsheetId)}/values/${encodeURIComponent(range)}?${params.toString()}`,
  });
  return result.values ?? [];
}

/** Writes values exactly as given (RAW: no formula or locale parsing). */
export async function updateValues(
  session: GoogleSession,
  spreadsheetId: string,
  range: string,
  values: readonly (readonly (string | number)[])[],
): Promise<void> {
  await session.request<unknown>({
    method: 'PUT',
    url: `${spreadsheetUrl(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    body: { range, majorDimension: 'ROWS', values },
  });
}

export type SheetsBatchRequest =
  | {
      readonly updateSheetProperties: {
        readonly properties: {
          readonly sheetId: number;
          readonly title?: string;
          readonly gridProperties?: { readonly frozenRowCount: number };
        };
        readonly fields: string;
      };
    }
  | {
      readonly addSheet: {
        readonly properties: { readonly title: string; readonly gridProperties?: { readonly frozenRowCount: number } };
      };
    };

export async function batchUpdate(
  session: GoogleSession,
  spreadsheetId: string,
  requests: readonly SheetsBatchRequest[],
): Promise<{ replies?: { addSheet?: { properties?: Record<string, unknown> } }[] }> {
  return session.request({
    method: 'POST',
    url: `${spreadsheetUrl(spreadsheetId)}:batchUpdate`,
    body: { requests },
  });
}

export interface AppendResult {
  /** A1 range Google wrote to, e.g. "'Expenses'!A7:E7". */
  readonly updatedRange: string | null;
  readonly updatedRows: number;
}

/**
 * Appends one row after the table that starts at `tableRange` (the header).
 * RAW keeps text literal (no formulas, no date/number guessing); INSERT_ROWS
 * inserts new rows so nothing below is overwritten.
 */
export async function appendRow(
  session: GoogleSession,
  spreadsheetId: string,
  tableRange: string,
  row: readonly (string | number)[],
  timeoutMs: number,
): Promise<AppendResult> {
  const params = new URLSearchParams({
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    includeValuesInResponse: 'false',
  });
  const result = await session.request<{ updates?: { updatedRange?: unknown; updatedRows?: unknown } }>({
    method: 'POST',
    url: `${spreadsheetUrl(spreadsheetId)}/values/${encodeURIComponent(tableRange)}:append?${params.toString()}`,
    body: { range: tableRange, majorDimension: 'ROWS', values: [row] },
    timeoutMs,
  });
  return {
    updatedRange: typeof result.updates?.updatedRange === 'string' ? result.updates.updatedRange : null,
    updatedRows: typeof result.updates?.updatedRows === 'number' ? result.updates.updatedRows : 0,
  };
}
