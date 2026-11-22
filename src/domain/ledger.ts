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
  /** 1-based row number in the sheet. */
  readonly rowNumber: number;
  readonly kind: LedgerIssueKind;
  readonly expenseId: string | null;
}

export interface LedgerExpense extends ExpensePayload {
  readonly expenseId: string;
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

export function buildLedger(rows: readonly SheetRowInput[], minorUnits: number): Ledger {
  const issues: LedgerIssue[] = [];
  const idsInSheet = new Set<string>();
  const byId = new Map<string, LedgerExpense[]>();
  let emptyRows = 0;

  for (const { rowNumber, cells } of rows) {
    const inspection = inspectSheetRow(cells, minorUnits);
    if (inspection.kind === 'empty') {
      emptyRows += 1;
      continue;
    }
    if (inspection.kind === 'invalid') {
      if (inspection.expenseId !== null) idsInSheet.add(inspection.expenseId);
      issues.push({ rowNumber, kind: inspection.problem, expenseId: inspection.expenseId });
      continue;
    }
    const expense: LedgerExpense = { ...inspection.expense, rowNumber };
    idsInSheet.add(expense.expenseId);
    const group = byId.get(expense.expenseId);
    if (group === undefined) byId.set(expense.expenseId, [expense]);
    else group.push(expense);
  }

  const expenses: LedgerExpense[] = [];
  for (const [expenseId, group] of byId) {
    const [first, ...rest] = group;
    if (first === undefined) continue;
    if (rest.every((row) => sameValues(row, first))) {
      expenses.push(first);
      for (const row of rest) issues.push({ rowNumber: row.rowNumber, kind: 'duplicate_resolved', expenseId });
    } else {
      for (const row of group) issues.push({ rowNumber: row.rowNumber, kind: 'conflicting_duplicate', expenseId });
    }
  }

  expenses.sort((a, b) => a.rowNumber - b.rowNumber);
  issues.sort((a, b) => a.rowNumber - b.rowNumber);
  return { expenses, issues, emptyRows, idsInSheet };
}
