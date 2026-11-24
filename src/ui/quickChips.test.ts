import { DEFAULT_QUICK_CATEGORIES } from '@/domain/categories';

import { estimateChipWidth, rowsNeeded, SEE_MORE_LABEL, visibleQuickChips } from './quickChips';

const at = (fontScale: number) => (label: string) => estimateChipWidth(label, fontScale);
const defaults = [...DEFAULT_QUICK_CATEGORIES];

test('rows are counted left to right with wrapping', () => {
  expect(rowsNeeded([100, 100, 100], 320)).toBe(1);
  expect(rowsNeeded([100, 100, 100, 100], 320)).toBe(2);
  expect(rowsNeeded([500, 100], 320)).toBe(2); // a chip wider than the row takes a row of its own
});

test('a wide screen at normal text shows all six, with "See more", in two rows', () => {
  const shown = visibleQuickChips(defaults, null, 720, at(1));
  expect(shown).toEqual(defaults);
  expect(rowsNeeded([...shown, SEE_MORE_LABEL].map(at(1)), 720)).toBeLessThanOrEqual(2);
});

test.each([
  ['typical phone (412 dp)', 380, 1],
  ['narrow phone (320 dp)', 288, 1],
  ['narrow phone, 130 % text', 288, 1.3],
  ['narrow phone, 200 % text', 288, 2],
])('%s: never more than two rows; fewer chips rather than smaller ones', (_label, available, fontScale) => {
  const shown = visibleQuickChips(defaults, null, available, at(fontScale));
  expect(shown.length).toBeGreaterThanOrEqual(1);
  expect(shown).toEqual(defaults.slice(0, shown.length)); // in rank order
  if (shown.length > 1) expect(rowsNeeded([...shown, SEE_MORE_LABEL].map(at(fontScale)), available)).toBeLessThanOrEqual(2);
});

test('larger text shows no more chips than normal text', () => {
  const normal = visibleQuickChips(defaults, null, 288, at(1)).length;
  const large = visibleQuickChips(defaults, null, 288, at(2)).length;
  expect(large).toBeLessThanOrEqual(normal);
});

test('a category chosen from "See more" replaces the last chip, without adding a row', () => {
  const before = visibleQuickChips(defaults, null, 380, at(1));
  const after = visibleQuickChips(defaults, 'Pets', 380, at(1));
  expect(after).toHaveLength(before.length);
  expect(after.slice(0, -1)).toEqual(before.slice(0, -1));
  expect(after.at(-1)).toBe('Pets');
});

test('a long chosen name may push out one more chip, but stays visible', () => {
  const name = 'Children’s weekend activities';
  const after = visibleQuickChips(defaults, name, 288, at(1));
  expect(after.at(-1)).toBe(name);
  expect(rowsNeeded([...after, SEE_MORE_LABEL].map(at(1)), 288)).toBeLessThanOrEqual(2);
});

test('a chosen category already shown is not duplicated', () => {
  expect(visibleQuickChips(defaults, 'Groceries', 720, at(1))).toEqual(defaults);
});
