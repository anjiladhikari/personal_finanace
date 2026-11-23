import { breakdownByCategory, percentTenths } from './analysis';

describe('breakdownByCategory', () => {
  test('empty input gives a zero total and no categories', () => {
    expect(breakdownByCategory([])).toEqual({ totalMinor: 0, categories: [] });
  });

  test('sorts by descending amount; equal amounts by category name (code-point order)', () => {
    const result = breakdownByCategory([
      { category: 'Transport', amountMinor: 500 },
      { category: 'Bills', amountMinor: 2_000 },
      { category: 'Health', amountMinor: 500 },
      { category: 'Eating out', amountMinor: 500 },
    ]);
    expect(result.categories.map((c) => c.category)).toEqual(['Bills', 'Eating out', 'Health', 'Transport']);
    expect(result.totalMinor).toBe(3_500);
  });

  test('percentages add up to exactly 100 (largest remainder)', () => {
    const thirds = breakdownByCategory([
      { category: 'A', amountMinor: 100 },
      { category: 'B', amountMinor: 100 },
      { category: 'C', amountMinor: 100 },
    ]);
    expect(thirds.categories.map((c) => c.percentage)).toEqual([33.34, 33.33, 33.33]);

    const awkward = breakdownByCategory([
      { category: 'A', amountMinor: 1 },
      { category: 'B', amountMinor: 1 },
      { category: 'C', amountMinor: 999_998 },
    ]);
    expect(awkward.categories.reduce((sum, c) => sum + c.percentBasisPoints, 0)).toBe(10_000);
    // 99.9998 % / 0.0001 % / 0.0001 %: the spare hundredth goes to the largest remainder.
    expect(awkward.categories.map((c) => c.percentage)).toEqual([100, 0, 0]);
  });

  test('a single category is 100 %', () => {
    expect(breakdownByCategory([{ category: 'Bills', amountMinor: 12_345 }]).categories).toEqual([
      { category: 'Bills', amountMinor: 12_345, percentBasisPoints: 10_000, percentage: 100 },
    ]);
  });

  test('stays exact for large totals', () => {
    const result = breakdownByCategory([
      { category: 'A', amountMinor: 3_000_000_000 },
      { category: 'B', amountMinor: 1_000_000_000 },
    ]);
    expect(result.totalMinor).toBe(4_000_000_000);
    expect(result.categories.map((c) => c.percentage)).toEqual([75, 25]);
  });
});

describe('percentTenths', () => {
  test('rounds to tenths of a percent for display and still adds up to exactly 100.0', () => {
    expect(percentTenths([100, 100, 100])).toEqual([334, 333, 333]);
    expect(percentTenths([50_000, 25_000])).toEqual([667, 333]);
    expect(percentTenths([5_250, 750])).toEqual([875, 125]);
    expect(percentTenths([2_050, 2_050, 2_050, 2_050, 450, 450, 450, 450])).toEqual([205, 205, 205, 205, 45, 45, 45, 45]);
  });

  test('a tiny share can round to 0; the spare tenth goes to the largest remainder', () => {
    expect(percentTenths([999_998, 1, 1])).toEqual([1_000, 0, 0]);
    expect(percentTenths([1_000_000_000, 1])).toEqual([1_000, 0]);
  });

  test('empty or zero input gives zeros', () => {
    expect(percentTenths([])).toEqual([]);
    expect(percentTenths([0, 0])).toEqual([0, 0]);
  });
});
