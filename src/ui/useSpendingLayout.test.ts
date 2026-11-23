import { spendingLayout } from './useSpendingLayout';

test.each<[string, number, number, boolean]>([
  ['narrow phone (320 dp), default text', 320, 1, true],
  ['narrow phone, largest Android text (200 %)', 320, 2, true],
  ['typical phone (411 dp), default text', 411, 1, false],
  ['typical phone, 130 % text', 411, 1.3, true],
  ['typical phone, 200 % text', 411, 2, true],
  ['large phone (480 dp), default text', 480, 1, false],
])('%s', (_label, width, fontScale, compact) => {
  const layout = spendingLayout(width, fontScale);
  expect(layout.compact).toBe(compact);
  // The pie (plus its 2 px gaps) fits inside the screen and card padding.
  expect(layout.pieRadius * 2 + 2).toBeLessThanOrEqual(width - 64);
});

test('the pie never grows past its maximum or shrinks to nothing', () => {
  expect(spendingLayout(1_200, 1).pieRadius).toBe(120);
  expect(spendingLayout(100, 1).pieRadius).toBe(48);
  expect(spendingLayout(320, 0).compact).toBe(true);
});
