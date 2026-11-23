import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The V1 reference fixture. `reference-ledger.tsv` is the single data source:
 * the automated tests read it, and the same rows can be pasted under the
 * header of a dedicated test spreadsheet for the device check
 * (docs/v1-verification.md).
 */
export const REFERENCE_TSV = join(__dirname, 'reference-ledger.tsv');

export type ReferenceCells = [date: string, description: string, amount: string, category: string, expenseId: string];

export function referenceRows(): ReferenceCells[] {
  return readFileSync(REFERENCE_TSV, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.split('\t') as ReferenceCells);
}

/** Days since 1899-12-30: how Google Sheets stores a date typed or pasted into a cell. */
export function sheetsDateSerial(date: string): number {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return (Date.UTC(year, month - 1, day) - Date.UTC(1899, 11, 30)) / 86_400_000;
}

/** The ways the same rows can reach the app from Google Sheets. */
export const REFERENCE_REPRESENTATIONS: readonly [string, (cells: ReferenceCells) => unknown[]][] = [
  // What the app itself appends (RAW): text date, numeric amount.
  ['as the app writes them', ([date, description, amount, category, id]) => [date, description, Number(amount), category, id]],
  // What Sheets stores when the rows are pasted or typed by hand: date serial, number.
  ['as pasted into Google Sheets', ([date, description, amount, category, id]) => [sheetsDateSerial(date), description, Number(amount), category, id]],
  // Cells formatted as plain text in the sheet.
  ['as plain-text cells', (cells) => [...cells]],
];

/** Expected results, in minor units (AUD cents). */
export const REFERENCE_EXPECTED = {
  day20261008: 5_000,
  october2026: {
    totalMinor: 6_000,
    categories: [
      { category: 'Groceries', amountMinor: 5_250, percentBasisPoints: 8_750, percentage: 87.5 },
      { category: 'Transport', amountMinor: 750, percentBasisPoints: 1_250, percentage: 12.5 },
    ],
  },
  year2026: 8_000,
  allTime: 8_500,
} as const;
