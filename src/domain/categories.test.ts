import {
  BUILT_IN_CATEGORIES,
  BUILT_IN_REGISTRY,
  buildCategoryRegistry,
  categoryKey,
  DEFAULT_QUICK_CATEGORIES,
  parseCategoryRow,
  pickerOrder,
  rankQuickCategories,
  searchCategories,
  validateCategoryName,
} from './categories';

const custom = (id: string, name: string, colour = 'red') => ({ id, name, icon: 'tag', colour });

describe('built-in categories', () => {
  test('the original categories keep their stored names and IDs; the new expense categories are added', () => {
    expect(BUILT_IN_CATEGORIES.map((c) => c.name)).toEqual([
      'Groceries',
      'Eating out',
      'Transport',
      'Bills',
      'Shopping',
      'Health',
      'Other',
      'Rent & mortgage',
      'Utilities',
      'Phone & internet',
      'Insurance',
      'Home & maintenance',
      'Fuel',
      'Vehicle maintenance',
      'Entertainment',
      'Subscriptions',
      'Travel & holidays',
      'Personal care',
      'Fitness & sport',
      'Education',
      'Children & family',
      'Pets',
      'Gifts & donations',
      'Fees & interest',
      'Taxes',
      'Work expenses',
    ]);
    expect(new Set(BUILT_IN_CATEGORIES.map((c) => c.id)).size).toBe(BUILT_IN_CATEGORIES.length);
    expect(BUILT_IN_CATEGORIES.slice(0, 7).map((c) => c.colour)).toEqual(['blue', 'orange', 'aqua', 'yellow', 'magenta', 'green', 'violet']);
  });

  test('no income, investment, transfer or cash-withdrawal categories', () => {
    const names = BUILT_IN_CATEGORIES.map((c) => c.name.toLowerCase()).join('|');
    expect(names).not.toMatch(/income|salary|invest|transfer|withdraw|cash/);
  });
});

describe('validateCategoryName', () => {
  const registry = buildCategoryRegistry([custom('c1', 'Kids’ swimming')], ['Typed in sheet']);

  test('trims surrounding whitespace and collapses repeated spaces', () => {
    expect(validateCategoryName('   Dog   walking  ', registry)).toEqual({ ok: true, name: 'Dog walking' });
  });

  test('rejects blank names', () => {
    expect(validateCategoryName('', registry)).toEqual({ ok: false, error: 'blank' });
    expect(validateCategoryName(' \t \n ', registry)).toEqual({ ok: false, error: 'blank' });
  });

  test('allows 30 characters and rejects 31', () => {
    expect(validateCategoryName('a'.repeat(30), registry)).toMatchObject({ ok: true });
    expect(validateCategoryName('a'.repeat(31), registry)).toEqual({ ok: false, error: 'too_long' });
    expect(validateCategoryName(`  ${'a'.repeat(30)}  `, registry)).toMatchObject({ ok: true });
  });

  test('rejects control characters', () => {
    expect(validateCategoryName('Bad\u0007name', registry)).toEqual({ ok: false, error: 'invalid_characters' });
  });

  test.each([
    ['built-in, different case', 'groceries', 'Groceries'],
    ['built-in, extra spaces', '  Eating    OUT ', 'Eating out'],
    ['new built-in', 'rent & MORTGAGE', 'Rent & mortgage'],
    ['custom', 'KIDS’  SWIMMING', 'Kids’ swimming'],
    ['label found in expenses', 'typed in SHEET', 'Typed in sheet'],
  ])('rejects a duplicate of a %s and names the existing one', (_label, input, existing) => {
    expect(validateCategoryName(input, registry)).toMatchObject({ ok: false, error: 'duplicate', existing: { name: existing } });
  });
});

describe('registry', () => {
  test('built-ins win over a custom definition of the same name; custom over a label found in expenses', () => {
    const registry = buildCategoryRegistry(
      [custom('c1', 'GROCERIES'), custom('c2', 'Kids')],
      ['kids', 'Typed in sheet', 'Groceries'],
    );
    expect(registry.find('groceries')).toMatchObject({ id: 'groceries', name: 'Groceries', source: 'built_in' });
    expect(registry.find('KIDS')).toMatchObject({ id: 'c2', name: 'Kids', source: 'custom', colour: 'red' });
    expect(registry.find('typed in sheet')).toMatchObject({ name: 'Typed in sheet', source: 'history' });
    expect(registry.all.filter((c) => categoryKey(c.name) === 'kids')).toHaveLength(1);
  });

  test('an expense may only use a stored name exactly (labels are never rewritten)', () => {
    const registry = buildCategoryRegistry([custom('c2', 'Kids')], ['Typed in sheet']);
    expect(registry.isSelectable('Kids')).toBe(true);
    expect(registry.isSelectable('Typed in sheet')).toBe(true);
    expect(registry.isSelectable('kids')).toBe(false);
    expect(BUILT_IN_REGISTRY.isSelectable('Work expenses')).toBe(true);
  });

  test('picker order is alphabetical, ignoring case, with Other last', () => {
    const registry = buildCategoryRegistry([custom('c1', 'aardvark care'), custom('c2', 'Zoo')], ['middle label']);
    const names = pickerOrder(registry).map((c) => c.name);
    expect(names[0]).toBe('aardvark care');
    expect(names.at(-1)).toBe('Other');
    expect(names.at(-2)).toBe('Zoo');
    expect(names).toContain('middle label');
    const withoutOther = names.slice(0, -1);
    expect([...withoutOther].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1))).toEqual(withoutOther);
  });

  test('search is case-insensitive, finds custom categories, and can find nothing', () => {
    const ordered = pickerOrder(buildCategoryRegistry([custom('c1', 'Kids’ swimming')], []));
    expect(searchCategories(ordered, 'GROC').map((c) => c.name)).toEqual(['Groceries']);
    expect(searchCategories(ordered, 'swim').map((c) => c.name)).toEqual(['Kids’ swimming']);
    expect(searchCategories(ordered, '  & ').map((c) => c.name)).toEqual([
      'Children & family',
      'Fees & interest',
      'Fitness & sport',
      'Gifts & donations',
      'Home & maintenance',
      'Phone & internet',
      'Rent & mortgage',
      'Travel & holidays',
    ]);
    expect(searchCategories(ordered, 'zzz')).toEqual([]);
    expect(searchCategories(ordered, '')).toHaveLength(ordered.length);
  });
});

describe('quick-access ranking', () => {
  const registry = buildCategoryRegistry([custom('c1', 'Kids')], ['Typed in sheet']);

  test('with no history, the six defaults', () => {
    expect(rankQuickCategories([], registry)).toEqual([...DEFAULT_QUICK_CATEGORIES]);
  });

  test('ranks by number of expenses, not amount, and fills the rest from the defaults', () => {
    expect(
      rankQuickCategories(
        [
          { category: 'Kids', count: 5 },
          { category: 'Fuel', count: 3 },
          { category: 'Groceries', count: 1 },
        ],
        registry,
      ),
    ).toEqual(['Kids', 'Fuel', 'Groceries', 'Eating out', 'Transport', 'Bills']);
  });

  test('ties go to the default order first, then the name, whatever the input order', () => {
    const usage = [
      { category: 'Zoo', count: 2 },
      { category: 'Typed in sheet', count: 2 },
      { category: 'Bills', count: 2 },
      { category: 'Groceries', count: 2 },
    ];
    const withZoo = buildCategoryRegistry([custom('c1', 'Zoo')], ['Typed in sheet']);
    expect(rankQuickCategories(usage, withZoo)).toEqual(['Groceries', 'Bills', 'Typed in sheet', 'Zoo', 'Eating out', 'Transport']);
    expect(rankQuickCategories([...usage].reverse(), withZoo)).toEqual(rankQuickCategories(usage, withZoo));
  });

  test('at most six; labels written differently count towards the same category', () => {
    const usage = ['Fuel', 'Pets', 'Taxes', 'Utilities', 'Insurance', 'Education', 'Travel & holidays'].map((category, i) => ({
      category,
      count: 10 - i,
    }));
    expect(rankQuickCategories(usage, registry)).toHaveLength(6);
    expect(rankQuickCategories([{ category: 'groceries', count: 1 }, { category: 'Groceries', count: 1 }, { category: 'Fuel', count: 1 }], registry)[0]).toBe('Groceries');
  });
});

describe('Categories tab rows', () => {
  test('a valid definition row', () => {
    expect(parseCategoryRow(['custom-1', 'Kids', 'tag', 'red', '2026-11-25T00:00:00.000Z'])).toEqual({
      id: 'custom-1',
      name: 'Kids',
      icon: 'tag',
      colour: 'red',
    });
  });

  test('unusable rows are skipped; unknown icons and colours fall back', () => {
    expect(parseCategoryRow(['', 'Kids'])).toBeNull();
    expect(parseCategoryRow(['id', '   '])).toBeNull();
    expect(parseCategoryRow(['id', 'x'.repeat(31)])).toBeNull();
    expect(parseCategoryRow(['id', 'Kids', 'rocket', 'purple'])).toMatchObject({ icon: 'tag', colour: expect.stringMatching(/^[a-z]+$/) });
    // A name Sheets returned as a number is still text.
    expect(parseCategoryRow(['id', 2026])).toMatchObject({ name: '2026' });
  });
});
