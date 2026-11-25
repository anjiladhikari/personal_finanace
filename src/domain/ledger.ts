import type { ExpensePayload } from './expense';
import { inspectSheetRow, type RowProblem } from './sheetRow';

/**
 * Turns the rows read from the Expenses tab into the confirmed ledger.
 *
 * Policy:
 * - Empty rows are skipped.
 * - Rows with a missing ID, invalid date, invalid amount or missing category
 *   are excluded and reported with their row number.
 * - Rows sharing an Expense ID with identical values (e.g. a retried write that
 *   landed twice) are one expense: the first row counts, later rows are
 *   reported as resolved duplicates.
 * - Rows sharing an Expense ID with different values conflict: none of them
 *   is counted, and every one is reported, so totals never silently pick one.
 */

export type LedgerIssueKind = RowProblem | 'conflicting_duplicate' | 'duplicate_resolved';

export interface LedgerIssue {
  /** The yearly tab the row is in, e.g. "2026". */
  readonly tab: string;
  /** 1-based row number in that tab. */
  readonly rowNumber: number;
  readonly kind: LedgerIssueKind;
  readonly expenseId: string | null;
}

export interface LedgerExpense extends ExpensePayload {
  readonly expenseId: string;
  readonly tab: string;
  readonly rowNumber: number;
}

export interface Ledger {
  readonly expenses: readonly LedgerExpense[];
  readonly issues: readonly LedgerIssue[];
  readonly emptyRows: number;
  /** Every Expense ID present in the sheet, valid or not. */
  readonly idsInSheet: ReadonlySet<string>;
}

export interface SheetRowInput {
  /** The yearly tab the row was read from ("2026"). */
  readonly tab: string;
  readonly rowNumber: number;
  readonly cells: readonly unknown[];
}

/** Issues that remove a row from the totals (resolved duplicates do not). */
export function affectsTotals(kind: LedgerIssueKind): boolean {
  return kind !== 'duplicate_resolved';
}

function sameValues(a: ExpensePayload, b: ExpensePayload): boolean {
  return (
    a.purchaseDate === b.purchaseDate &&
    a.description === b.description &&
    a.amountMinor === b.amountMinor &&
    a.category === b.category
  );
}

interface Located {
  readonly tab: string;
  readonly rowNumber: number;
}

function bySheetPosition(a: Located, b: Located): number {
  if (a.tab !== b.tab) return a.tab < b.tab ? -1 : 1;
  return a.rowNumber - b.rowNumber;
}

/** Sorts by tab, then row, unless already in order (the usual case: tabs and rows arrive in order). */
function inRowOrder<T extends Located>(items: T[]): T[] {
  for (let i = 1; i < items.length; i += 1) {
    if (bySheetPosition(items[i - 1] as T, items[i] as T) > 0) return items.sort(bySheetPosition);
  }
  return items;
}

/**
 * Builds a ledger one row at a time, so a caller can validate a long sheet in
 * slices and let the UI run in between. The result is the same as
 * `buildLedger` over the same rows in the same order. Single use: call
 * `finish` once, after the last `add`.
 */
export class LedgerBuilder {
  private readonly issues: LedgerIssue[] = [];
  private readonly idsInSheet = new Set<string>();
  /** First valid row for each Expense ID, in the order first seen. */
  private readonly firstById = new Map<string, LedgerExpense>();
  /** Later valid rows, only for IDs seen more than once. */
  private readonly laterById = new Map<string, LedgerExpense[]>();
  private emptyRows = 0;

  constructor(private readonly minorUnits: number) {}

  add({ tab, rowNumber, cells }: SheetRowInput): void {
    const inspection = inspectSheetRow(cells, this.minorUnits);
    if (inspection.kind === 'empty') {
      this.emptyRows += 1;
      return;
    }
    if (inspection.kind === 'invalid') {
      if (inspection.expenseId !== null) this.idsInSheet.add(inspection.expenseId);
      this.issues.push({ tab, rowNumber, kind: inspection.problem, expenseId: inspection.expenseId });
      return;
    }
    const expense: LedgerExpense = { ...inspection.expense, tab, rowNumber };
    const { expenseId } = expense;
    this.idsInSheet.add(expenseId);
    if (!this.firstById.has(expenseId)) {
      this.firstById.set(expenseId, expense);
      return;
    }
    const later = this.laterById.get(expenseId);
    if (later === undefined) this.laterById.set(expenseId, [expense]);
    else later.push(expense);
  }

  finish(): Ledger {
    const { issues, laterById } = this;
    const expenses: LedgerExpense[] = [];
    this.firstById.forEach((first, expenseId) => {
      const later = laterById.get(expenseId);
      if (later === undefined) {
        expenses.push(first);
      } else if (later.every((row) => sameValues(row, first))) {
        expenses.push(first);
        for (const row of later) issues.push({ tab: row.tab, rowNumber: row.rowNumber, kind: 'duplicate_resolved', expenseId });
      } else {
        for (const row of [first, ...later]) issues.push({ tab: row.tab, rowNumber: row.rowNumber, kind: 'conflicting_duplicate', expenseId });
      }
    });
    return { expenses: inRowOrder(expenses), issues: inRowOrder(issues), emptyRows: this.emptyRows, idsInSheet: this.idsInSheet };
  }
}

export function buildLedger(rows: readonly SheetRowInput[], minorUnits: number): Ledger {
  const builder = new LedgerBuilder(minorUnits);
  for (const row of rows) builder.add(row);
  return builder.finish();
}
