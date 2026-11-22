import { breakdownByCategory, type CategoryShare } from '@/domain/analysis';
import { periodRange, type LocalDate, type Period } from '@/domain/dates';
import type { DataScope } from '@/domain/expense';

import type { SqlDatabase } from './sql';

export interface SpendingAnalysis {
  readonly period: Period;
  /** Inclusive start; null for all time. */
  readonly start: LocalDate | null;
  /** Exclusive end; null for all time. */
  readonly endExclusive: LocalDate | null;
  readonly totalMinor: number;
  /** Descending amount; equal amounts ordered by category name. */
  readonly categories: readonly CategoryShare[];
  readonly lastSuccessfulSyncAt: string | null;
  /**
   * Sheet rows excluded from every total (invalid rows and conflicting
   * duplicates) as of the last refresh. Non-zero means totals are incomplete.
   */
  readonly excludedRowCount: number;
}

/**
 * Confirmed spending for a period, from SQLite only (no network). Day, month
 * and year filter on purchase_date with a half-open range; all time has no
 * date filter. Pending submissions are never included.
 */
export async function analyzeSpending(db: SqlDatabase, scope: DataScope, period: Period): Promise<SpendingAnalysis> {
  const range = periodRange(period);
  const totals = await db.getAll<{ category: string; amount_minor: number }>(
    `SELECT category, SUM(amount_minor) AS amount_minor
     FROM confirmed_expenses
     WHERE account_id = ? AND spreadsheet_id = ?
       AND purchase_date >= ? AND purchase_date < ?
     GROUP BY category`,
    [scope.accountId, scope.spreadsheetId, range?.start ?? '0000-01-01', range?.endExclusive ?? '9999-12-31'],
  );
  const settings = await db.getFirst<{ last_successful_sync_at: string | null }>(
    'SELECT last_successful_sync_at FROM app_settings WHERE id = ?',
    [1],
  );
  const excluded = await db.getFirst<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sheet_issues
     WHERE account_id = ? AND spreadsheet_id = ? AND kind != 'duplicate_resolved'`,
    [scope.accountId, scope.spreadsheetId],
  );

  const breakdown = breakdownByCategory(
    totals.map((row) => ({ category: row.category, amountMinor: row.amount_minor })),
  );
  return {
    period,
    start: range?.start ?? null,
    endExclusive: range?.endExclusive ?? null,
    totalMinor: breakdown.totalMinor,
    categories: breakdown.categories,
    lastSuccessfulSyncAt: settings?.last_successful_sync_at ?? null,
    excludedRowCount: excluded?.n ?? 0,
  };
}
