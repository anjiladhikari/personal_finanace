/**
 * Synthetic ledger for performance runs: 10 expenses a day for 3,650 days
 * (36,500 rows, ten years ending on `lastDay`). Deterministic, so every run
 * measures the same data. No real expense data.
 */
const CATEGORIES = ['Groceries', 'Eating out', 'Transport', 'Bills', 'Shopping', 'Health', 'Other'] as const;

export const LARGE_LEDGER_DAYS = 3_650;
export const LARGE_LEDGER_PER_DAY = 10;

function addDaysUtc(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(year, month - 1, day) + days * 86_400_000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/** Sheet rows as the app appends them: text date, numeric amount, category, ID. */
export function largeLedgerRows(lastDay = '2026-11-22'): unknown[][] {
  let seed = 42;
  const next = () => {
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
    return seed;
  };
  const rows: unknown[][] = [];
  for (let offset = LARGE_LEDGER_DAYS - 1; offset >= 0; offset -= 1) {
    const date = addDaysUtc(lastDay, -offset);
    for (let i = 0; i < LARGE_LEDGER_PER_DAY; i += 1) {
      const amountMinor = 100 + (next() % 19_900); // $1.00 to $199.99
      const category = CATEGORIES[next() % CATEGORIES.length] ?? 'Other';
      rows.push([date, `Synthetic expense ${rows.length + 1}`, amountMinor / 100, category, `perf-${rows.length + 1}`]);
    }
  }
  return rows;
}
