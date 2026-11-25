import { dataScopeOf, getAppSettings, isSetupComplete } from '@/db/appSettings';
import { replaceLedgerCache } from '@/db/ledgerCache';
import type { SqlDatabase } from '@/db/sql';
import type { SubmissionErrorCode } from '@/domain/expense';
import { affectsTotals, LedgerBuilder, type Ledger, type SheetRowInput } from '@/domain/ledger';
import { a1Range } from '@/domain/sheetContract';
import type { GoogleAuthorizer } from '@/google/authorization';
import { getDriveFile, type DriveFile } from '@/google/drive';
import type { FetchLike } from '@/google/http';
import type { GoogleSession } from '@/google/session';
import { getValues } from '@/google/sheets';

import { accessFailure, openSheetAccess } from './sheetAccess';
import { listYearTabs, type YearTab } from './yearTabs';

/** Rows per read request (provisional). Columns are always A:E only. */
export const REFRESH_CHUNK_ROWS = 2000;
/** A refresh that sees the sheet change while reading starts again, at most this many times in total. */
export const MAX_REFRESH_ATTEMPTS = 3;
/**
 * Rows validated between pauses. Validating a ten-year sheet in one go blocked
 * the JS thread for ~110 ms on a fast desktop (several times longer on a
 * phone); slices keep each block short so taps and rendering continue.
 */
export const LEDGER_SLICE_ROWS = 500;

/** Lets the UI run: a macrotask, so pending touches and frames are handled first. */
export function pauseForUi(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

export type RefreshFailureCode = SubmissionErrorCode | 'changed_during_refresh';

export type RefreshOutcome =
  | { readonly kind: 'refreshed'; readonly expenseCount: number; readonly excludedRowCount: number; readonly syncedAt: string }
  | { readonly kind: 'failed'; readonly code: RefreshFailureCode }
  | { readonly kind: 'not_set_up' };

export interface RefreshProgress {
  readonly attempt: number;
  /** Data rows read so far, across all yearly tabs. */
  readonly rowsRead: number;
  /** Data rows in all yearly tabs (an upper bound: grid size), when known. */
  readonly totalRows: number | null;
}

export interface RefreshDeps {
  readonly db: SqlDatabase;
  readonly authorizer: GoogleAuthorizer;
  readonly fetch: FetchLike;
  readonly isOnline: () => Promise<boolean>;
  readonly now: () => number;
  readonly refreshChunkRows?: number;
  /** Called between validation slices; defaults to `pauseForUi`. */
  readonly pause?: () => Promise<void>;
}

/** The same result as `buildLedger`, built in slices with a pause between them. */
export async function validateInSlices(
  rows: readonly SheetRowInput[],
  minorUnits: number,
  pause: () => Promise<void>,
  sliceRows = LEDGER_SLICE_ROWS,
): Promise<Ledger> {
  const builder = new LedgerBuilder(minorUnits);
  for (let index = 0; index < rows.length; index += 1) {
    if (index > 0 && index % sliceRows === 0) await pause();
    const row = rows[index];
    if (row !== undefined) builder.add(row);
  }
  return builder.finish();
}

function unchanged(before: DriveFile, after: DriveFile): boolean {
  return before.version === after.version && before.modifiedTime === after.modifiedTime;
}

/**
 * Reads rows 2..last of the Expenses tab in bounded requests. When the grid
 * size is unknown, reading stops at the first completely empty chunk.
 */
async function readRows(
  session: GoogleSession,
  spreadsheetId: string,
  tab: YearTab,
  chunkRows: number,
  onChunk: (rowsRead: number) => void,
): Promise<SheetRowInput[]> {
  const rows: SheetRowInput[] = [];
  const { rowCount, title } = tab;
  for (let start = 2; rowCount === null || start <= rowCount; start += chunkRows) {
    const end = rowCount === null ? start + chunkRows - 1 : Math.min(start + chunkRows - 1, rowCount);
    const values = await getValues(session, spreadsheetId, a1Range(title, `A${start}:E${end}`));
    values.forEach((cells, offset) => rows.push({ tab: title, rowNumber: start + offset, cells }));
    onChunk(end - 1);
    if (rowCount === null && values.length === 0) break;
  }
  return rows;
}

/**
 * Rebuilds the confirmed cache from the sheet. Nothing local changes unless
 * the complete sheet was read without it changing in between, validated, and
 * committed in one transaction; otherwise the previous cache stays as it was.
 */
export async function runRefresh(
  deps: RefreshDeps,
  onProgress: (progress: RefreshProgress) => void,
): Promise<RefreshOutcome> {
  const settings = await getAppSettings(deps.db);
  const scope = dataScopeOf(settings);
  if (!isSetupComplete(settings) || scope === null) return { kind: 'not_set_up' };
  if (!(await deps.isOnline())) return { kind: 'failed', code: 'offline' };

  const chunkRows = deps.refreshChunkRows ?? REFRESH_CHUNK_ROWS;
  for (let attempt = 1; attempt <= MAX_REFRESH_ATTEMPTS; attempt += 1) {
    const access = await openSheetAccess(deps, settings, scope);
    if (access.kind !== 'ready') return { kind: 'failed', code: access.error.code };

    const rows: SheetRowInput[] = [];
    let after: DriveFile;
    try {
      // Every yearly tab with the expense header; the original Expenses tab is not read.
      const tabs = await listYearTabs(access.session, scope.spreadsheetId);
      const totalRows = tabs.every((t) => t.rowCount !== null)
        ? tabs.reduce((sum, t) => sum + Math.max(0, (t.rowCount ?? 0) - 1), 0)
        : null;
      onProgress({ attempt, rowsRead: 0, totalRows });
      let before = 0;
      for (const tab of tabs) {
        const offset = before;
        const tabRows = await readRows(access.session, scope.spreadsheetId, tab, chunkRows, (rowsRead) =>
          onProgress({ attempt, rowsRead: offset + rowsRead, totalRows }),
        );
        rows.push(...tabRows);
        before += Math.max(0, (tab.rowCount ?? tabRows.length + 1) - 1);
      }
      after = await getDriveFile(access.session, scope.spreadsheetId);
    } catch (error) {
      return { kind: 'failed', code: accessFailure(error).error.code };
    }

    // Rows can shift between chunk requests if the sheet is edited meanwhile.
    // Our own writes cannot happen now (refresh holds the sync queue), so a
    // change means someone edited the sheet: read it again from the start.
    if (!unchanged(access.file, after)) continue;

    const ledger = await validateInSlices(rows, settings.currency.minorUnits, deps.pause ?? pauseForUi);
    const syncedAt = new Date(deps.now()).toISOString();
    const committed = await replaceLedgerCache(deps.db, scope, ledger, syncedAt);
    if (committed === 'binding_changed') return { kind: 'failed', code: 'account_mismatch' };
    return {
      kind: 'refreshed',
      expenseCount: ledger.expenses.length,
      excludedRowCount: ledger.issues.filter((issue) => affectsTotals(issue.kind)).length,
      syncedAt,
    };
  }
  return { kind: 'failed', code: 'changed_during_refresh' };
}
