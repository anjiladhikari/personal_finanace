import { addDays, parseLocalDate, type LocalDate } from './dates';
import type { ExpensePayload } from './expense';
import { formatMinorUnits, parseAmount } from './money';

/**
 * One Expenses row: Date | Description | Amount | Category | Expense ID.
 * Written with valueInputOption=RAW so text is stored literally (a
 * description such as "=SUM(A1)" is never evaluated as a formula), the date
 * stays "YYYY-MM-DD" text and the amount is a number in major units.
 */
export type SheetRow = readonly [date: string, description: string, amount: number, category: string, expenseId: string];

export function toSheetRow(expenseId: string, payload: ExpensePayload, minorUnits: number): SheetRow {
  const amount = Number(formatMinorUnits(payload.amountMinor, minorUnits, { grouping: false }));
  return [payload.purchaseDate, payload.description, amount, payload.category, expenseId];
}

// Google Sheets date serials count days from 1899-12-30.
const SHEETS_EPOCH = '1899-12-30';

function dateFromCell(cell: unknown): LocalDate | null {
  if (typeof cell === 'string') return parseLocalDate(cell.trim());
  if (typeof cell === 'number' && Number.isInteger(cell) && cell > 0) {
    try {
      return addDays(SHEETS_EPOCH as LocalDate, cell);
    } catch {
      return null;
    }
  }
  return null;
}

export type RowProblem = 'missing_id' | 'invalid_date' | 'invalid_amount' | 'missing_category';

export type RowInspection =
  | { readonly kind: 'empty' }
  | { readonly kind: 'valid'; readonly expense: ExpensePayload & { readonly expenseId: string } }
  | { readonly kind: 'invalid'; readonly problem: RowProblem; readonly expenseId: string | null };

function isBlank(cell: unknown): boolean {
  return cell === undefined || cell === null || String(cell).trim() === '';
}

/**
 * Checks one Expenses row (Date | Description | Amount | Category | Expense ID).
 * Problems are reported in that order of importance: ID, date, amount, category.
 * The description may be empty.
 */
export function inspectSheetRow(row: readonly unknown[], minorUnits: number): RowInspection {
  const cells = row.slice(0, 5);
  if (cells.every(isBlank)) return { kind: 'empty' };
  const [dateCell, descriptionCell, amountCell, categoryCell, idCell] = cells;

  const expenseId = isBlank(idCell) ? null : String(idCell).trim();
  if (expenseId === null) return { kind: 'invalid', problem: 'missing_id', expenseId: null };

  const purchaseDate = dateFromCell(dateCell);
  if (purchaseDate === null) return { kind: 'invalid', problem: 'invalid_date', expenseId };

  const amountText =
    typeof amountCell === 'number' ? String(amountCell) : typeof amountCell === 'string' ? amountCell : '';
  const amount = parseAmount(amountText, minorUnits);
  if (!amount.ok) return { kind: 'invalid', problem: 'invalid_amount', expenseId };

  const category = isBlank(categoryCell) ? '' : String(categoryCell).trim();
  if (category === '') return { kind: 'invalid', problem: 'missing_category', expenseId };

  const description = isBlank(descriptionCell) ? '' : String(descriptionCell).trim();
  return { kind: 'valid', expense: { expenseId, purchaseDate, description, amountMinor: amount.amountMinor, category } };
}

/**
 * Reads an Expenses row back into a payload (used to rebuild local state from
 * the remote record). Returns null if the row is not a valid expense.
 */
export function parseSheetRow(row: readonly unknown[], minorUnits: number): (ExpensePayload & { expenseId: string }) | null {
  const inspection = inspectSheetRow(row, minorUnits);
  return inspection.kind === 'valid' ? inspection.expense : null;
}
