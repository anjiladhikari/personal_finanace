import { breakdownByCategory } from './analysis';

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
