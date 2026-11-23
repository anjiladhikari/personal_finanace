import { breakdownByCategory } from './analysis';
import { PIE_MAX_SLICES, spendingChart, type PieSlice } from './spendingChart';

const sliceAmount = (slice: PieSlice) => (slice.kind === 'category' ? slice.category.amountMinor : slice.amountMinor);
const sliceTenths = (slice: PieSlice) => (slice.kind === 'category' ? slice.category.percentTenths : slice.percentTenths);

function chartOf(rows: Record<string, number>) {
  return spendingChart(breakdownByCategory(Object.entries(rows).map(([category, amountMinor]) => ({ category, amountMinor }))));
}

/** The invariants every chart must keep: one source, exact money, 100.0 %. */
function expectConsistent(chart: ReturnType<typeof spendingChart>) {
  const rowsTotal = chart.categories.reduce((sum, row) => sum + row.amountMinor, 0);
  expect(rowsTotal).toBe(chart.totalMinor);
  expect(chart.slices.reduce((sum, slice) => sum + sliceAmount(slice), 0)).toBe(chart.totalMinor);
  if (chart.categories.length > 0) {
    expect(chart.categories.reduce((sum, row) => sum + row.percentTenths, 0)).toBe(1_000);
    expect(chart.slices.reduce((sum, slice) => sum + sliceTenths(slice), 0)).toBe(1_000);
    expect(chart.categories[0]?.barFraction).toBe(1);
  }
  expect(chart.slices.length).toBeLessThanOrEqual(PIE_MAX_SLICES);
}

test('zero expenses: no bars, no slices, zero total', () => {
  const chart = chartOf({});
  expect(chart).toEqual({ totalMinor: 0, categories: [], slices: [] });
});

test('one category is a full bar and a single 100 % slice', () => {
  const chart = chartOf({ Bills: 12_345 });
  expectConsistent(chart);
  expect(chart.categories).toEqual([{ category: 'Bills', amountMinor: 12_345, percentTenths: 1_000, barFraction: 1 }]);
  expect(chart.slices).toEqual([{ kind: 'category', category: chart.categories[0] }]);
});

test('five categories are five slices, in the same order as the bars', () => {
  const chart = chartOf({ Bills: 500, Groceries: 400, Transport: 300, Health: 200, Other: 100 });
  expectConsistent(chart);
  expect(chart.slices.map((slice) => (slice.kind === 'category' ? slice.category.category : 'remaining'))).toEqual([
    'Bills',
    'Groceries',
    'Transport',
    'Health',
    'Other',
  ]);
});

test('seven categories: four largest slices plus "Remaining categories"; every category stays listed', () => {
  const chart = chartOf({ Bills: 700, Groceries: 600, Transport: 500, Health: 400, Shopping: 300, 'Eating out': 200, Other: 100 });
  expectConsistent(chart);

  expect(chart.categories.map((row) => row.category)).toEqual(['Bills', 'Groceries', 'Transport', 'Health', 'Shopping', 'Eating out', 'Other']);
  expect(chart.slices).toHaveLength(5);
  const remaining = chart.slices[4];
  expect(remaining).toMatchObject({ kind: 'remaining', amountMinor: 600 });
  if (remaining?.kind !== 'remaining') throw new Error('expected the aggregate slice');
  expect(remaining.categories.map((row) => row.category)).toEqual(['Shopping', 'Eating out', 'Other']);
  // The aggregate shows the sum of what its members show, so the list never disagrees with the pie.
  expect(remaining.percentTenths).toBe(remaining.categories.reduce((sum, row) => sum + row.percentTenths, 0));
});

test('six categories already aggregate the two smallest', () => {
  const chart = chartOf({ A: 600, B: 500, C: 400, D: 300, E: 200, F: 100 });
  expectConsistent(chart);
  expect(chart.slices[4]).toMatchObject({ kind: 'remaining', amountMinor: 300 });
});

test('bars share one scale: length is amount ÷ largest amount', () => {
  const chart = chartOf({ Bills: 50_000, Groceries: 25_000, Transport: 5_000 });
  expect(chart.categories.map((row) => row.barFraction)).toEqual([1, 0.5, 0.1]);
});

test('very unequal amounts keep exact money and still add up to 100 %', () => {
  const chart = chartOf({ Rent: 99_999_998, Gum: 1, Stamp: 1 });
  expectConsistent(chart);
  expect(chart.categories.map((row) => [row.category, row.amountMinor, row.percentTenths])).toEqual([
    ['Rent', 99_999_998, 1_000],
    ['Gum', 1, 0],
    ['Stamp', 1, 0],
  ]);
  expect(chart.categories[1]?.barFraction).toBeGreaterThan(0);
});

test('ties keep the analysis order (descending amount, then name)', () => {
  const chart = chartOf({ Transport: 100, Bills: 100, Health: 100 });
  expect(chart.categories.map((row) => [row.category, row.percentTenths])).toEqual([
    ['Bills', 334],
    ['Health', 333],
    ['Transport', 333],
  ]);
});
