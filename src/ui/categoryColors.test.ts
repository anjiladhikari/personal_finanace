import { BUILT_IN_CATEGORIES, buildCategoryRegistry } from '@/domain/categories';

import { categoryColor, remainingColor } from './categoryColors';

const ORIGINAL = BUILT_IN_CATEGORIES.slice(0, 7).map((c) => c.name);

describe.each(['light', 'dark'] as const)('%s scheme', (scheme) => {
  test('the original seven categories keep distinct colours, apart from the aggregate grey', () => {
    const colours = ORIGINAL.map((category) => categoryColor(category, scheme));
    expect(new Set(colours).size).toBe(ORIGINAL.length);
    expect(colours).not.toContain(remainingColor(scheme));
  });

  test('a label typed in the sheet always gets the same colour', () => {
    expect(categoryColor('Kids’ swimming lessons', scheme)).toBe(categoryColor('Kids’ swimming lessons', scheme));
    expect(categoryColor('Travel', scheme)).toMatch(/^#[0-9A-F]{6}$/);
  });
});

test('existing categories keep their colours (light and dark steps of one hue)', () => {
  expect(categoryColor('Groceries', 'light')).toBe('#2A78D6');
  expect(categoryColor('Groceries', 'dark')).toBe('#3987E5');
  expect(categoryColor('Bills', 'light')).toBe('#EDA100');
  expect(categoryColor('Bills', 'dark')).toBe('#C98500');
  expect(categoryColor('Other', 'light')).toBe('#6250D6');
});

test('every built-in and custom category has a defined colour; custom ones use their stored colour', () => {
  for (const builtIn of BUILT_IN_CATEGORIES) expect(categoryColor(builtIn.name)).toMatch(/^#[0-9A-F]{6}$/);
  const registry = buildCategoryRegistry([{ id: 'c1', name: 'Kids', icon: 'tag', colour: 'red' }], []);
  expect(categoryColor('Kids', 'light', registry)).toBe('#E34948');
  expect(categoryColor('kids', 'dark', registry)).toBe('#E66767');
});
