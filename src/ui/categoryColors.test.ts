import { EXPENSE_CATEGORIES } from '@/domain/expense';

import { categoryColor, REMAINING_COLOR } from './categoryColors';

test('each app category has its own fixed colour, distinct from the aggregate grey', () => {
  const colours = EXPENSE_CATEGORIES.map(categoryColor);
  expect(new Set(colours).size).toBe(EXPENSE_CATEGORIES.length);
  expect(colours).not.toContain(REMAINING_COLOR);
  expect(categoryColor('Groceries')).toBe('#2A78D6');
  expect(categoryColor('Bills')).toBe('#EDA100');
});

test('a category typed in the sheet always gets the same colour', () => {
  expect(categoryColor('Kids’ swimming lessons')).toBe(categoryColor('Kids’ swimming lessons'));
  expect(categoryColor('Travel')).toMatch(/^#[0-9A-F]{6}$/);
  // Matching is exact: a differently written name is a different category.
  expect(categoryColor('groceries')).toMatch(/^#[0-9A-F]{6}$/);
});
