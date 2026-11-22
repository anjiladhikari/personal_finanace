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

/**
 * Reads an Expenses row back into a payload (used to rebuild local state from
 * the remote record). Returns null if the row is not a valid expense.
 */
export function parseSheetRow(row: readonly unknown[], minorUnits: number): (ExpensePayload & { expenseId: string }) | null {
  const [dateCell, descriptionCell, amountCell, categoryCell, idCell] = row;
  const purchaseDate = dateFromCell(dateCell);
  const description = typeof descriptionCell === 'string' ? descriptionCell : String(descriptionCell ?? '');
  const category = typeof categoryCell === 'string' ? categoryCell.trim() : '';
  const expenseId = typeof idCell === 'string' ? idCell.trim() : '';
  const amountText =
    typeof amountCell === 'number' ? String(amountCell) : typeof amountCell === 'string' ? amountCell : '';
  const amount = parseAmount(amountText, minorUnits);

  if (purchaseDate === null || !amount.ok || category === '' || expenseId === '') return null;
  return { expenseId, purchaseDate, description, amountMinor: amount.amountMinor, category };
}
