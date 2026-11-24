/**
 * The category registry: built-in categories, the user's own categories and
 * labels found in existing expense rows. Expenses store the category *name*
 * (as they always have, in SQLite and in the Expenses tab); definitions add a
 * stable ID, an icon and a chart colour.
 */

/** Chart colour of a category, by hue. The UI maps each to a light and a dark step. */
export const CATEGORY_COLOURS = ['blue', 'orange', 'aqua', 'yellow', 'magenta', 'green', 'violet', 'red'] as const;
export type CategoryColour = (typeof CATEGORY_COLOURS)[number];

/** Icon keys the app can draw. Unknown keys fall back to DEFAULT_CATEGORY_ICON. */
export const CATEGORY_ICON_KEYS = [
  'groceries',
  'eating-out',
  'transport',
  'bills',
  'shopping',
  'health',
  'other',
  'home',
  'bolt',
  'phone',
  'shield',
  'wrench',
  'fuel',
  'car',
  'ticket',
  'repeat',
  'plane',
  'sparkle',
  'dumbbell',
  'graduation',
  'family',
  'paw',
  'gift',
  'percent',
  'landmark',
  'briefcase',
  'tag',
] as const;
export type CategoryIconKey = (typeof CATEGORY_ICON_KEYS)[number];
export const DEFAULT_CATEGORY_ICON: CategoryIconKey = 'tag';

export const CATEGORY_NAME_MAX_LENGTH = 30;
export const OTHER_CATEGORY = 'Other';

export type CategorySource = 'built_in' | 'custom' | 'history';

export interface CategoryDefinition {
  /** Stable identifier. Built-ins use fixed slugs; custom categories a UUID. */
  readonly id: string;
  /** Exactly what is stored in expense rows and shown to the user. */
  readonly name: string;
  readonly icon: CategoryIconKey;
  readonly colour: CategoryColour;
  readonly source: CategorySource;
}

interface BuiltIn {
  readonly id: string;
  readonly name: string;
  readonly icon: CategoryIconKey;
  readonly colour: CategoryColour;
}

/**
 * Built-in categories. The first seven existed before this registry; their
 * names (the stored identifiers) and colours are unchanged.
 */
export const BUILT_IN_CATEGORIES: readonly BuiltIn[] = [
  { id: 'groceries', name: 'Groceries', icon: 'groceries', colour: 'blue' },
  { id: 'eating-out', name: 'Eating out', icon: 'eating-out', colour: 'orange' },
  { id: 'transport', name: 'Transport', icon: 'transport', colour: 'aqua' },
  { id: 'bills', name: 'Bills', icon: 'bills', colour: 'yellow' },
  { id: 'shopping', name: 'Shopping', icon: 'shopping', colour: 'magenta' },
  { id: 'health', name: 'Health', icon: 'health', colour: 'green' },
  { id: 'other', name: 'Other', icon: 'other', colour: 'violet' },
  { id: 'rent-mortgage', name: 'Rent & mortgage', icon: 'home', colour: 'red' },
  { id: 'utilities', name: 'Utilities', icon: 'bolt', colour: 'yellow' },
  { id: 'phone-internet', name: 'Phone & internet', icon: 'phone', colour: 'violet' },
  { id: 'insurance', name: 'Insurance', icon: 'shield', colour: 'aqua' },
  { id: 'home-maintenance', name: 'Home & maintenance', icon: 'wrench', colour: 'orange' },
  { id: 'fuel', name: 'Fuel', icon: 'fuel', colour: 'red' },
  { id: 'vehicle-maintenance', name: 'Vehicle maintenance', icon: 'car', colour: 'blue' },
  { id: 'entertainment', name: 'Entertainment', icon: 'ticket', colour: 'magenta' },
  { id: 'subscriptions', name: 'Subscriptions', icon: 'repeat', colour: 'violet' },
  { id: 'travel-holidays', name: 'Travel & holidays', icon: 'plane', colour: 'aqua' },
  { id: 'personal-care', name: 'Personal care', icon: 'sparkle', colour: 'magenta' },
  { id: 'fitness-sport', name: 'Fitness & sport', icon: 'dumbbell', colour: 'green' },
  { id: 'education', name: 'Education', icon: 'graduation', colour: 'blue' },
  { id: 'children-family', name: 'Children & family', icon: 'family', colour: 'orange' },
  { id: 'pets', name: 'Pets', icon: 'paw', colour: 'yellow' },
  { id: 'gifts-donations', name: 'Gifts & donations', icon: 'gift', colour: 'red' },
  { id: 'fees-interest', name: 'Fees & interest', icon: 'percent', colour: 'violet' },
  { id: 'taxes', name: 'Taxes', icon: 'landmark', colour: 'green' },
  { id: 'work-expenses', name: 'Work expenses', icon: 'briefcase', colour: 'aqua' },
];

/** The quick-access chips before there is any history, in this order. */
export const DEFAULT_QUICK_CATEGORIES: readonly string[] = ['Groceries', 'Eating out', 'Transport', 'Bills', 'Shopping', 'Health'];
export const QUICK_CATEGORY_LIMIT = 6;
export const QUICK_CATEGORY_WINDOW_DAYS = 90;

/** Trims and collapses runs of whitespace: the form a category name is stored in. */
export function tidyCategoryName(input: string): string {
  return input.trim().replace(/\s+/g, ' ');
}

/** Comparison key: names that differ only in case or spacing are the same category. */
export function categoryKey(name: string): string {
  return tidyCategoryName(name).toLowerCase();
}

function isCategoryIconKey(value: unknown): value is CategoryIconKey {
  return typeof value === 'string' && (CATEGORY_ICON_KEYS as readonly string[]).includes(value);
}

export function isCategoryColour(value: unknown): value is CategoryColour {
  return typeof value === 'string' && (CATEGORY_COLOURS as readonly string[]).includes(value);
}

export function iconOrDefault(value: unknown): CategoryIconKey {
  return isCategoryIconKey(value) ? value : DEFAULT_CATEGORY_ICON;
}

/** FNV-1a over UTF-16 code units: the same text gives the same number on every device. */
function hashText(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** Stable colour for a name without a stored one (custom categories at creation, history labels). */
export function colourForName(name: string): CategoryColour {
  return CATEGORY_COLOURS[hashText(categoryKey(name)) % CATEGORY_COLOURS.length] ?? 'blue';
}

export type CategoryNameError = 'blank' | 'too_long' | 'invalid_characters' | 'duplicate';

export type CategoryNameValidation =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly error: Exclude<CategoryNameError, 'duplicate'> }
  | { readonly ok: false; readonly error: 'duplicate'; readonly existing: CategoryDefinition };

// Control characters (including line breaks) cannot be part of a name.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** Checks a name typed for a new category against the whole registry. */
export function validateCategoryName(input: string, registry: CategoryRegistry): CategoryNameValidation {
  // Line breaks and tabs are whitespace, so tidying turns them into single spaces.
  const name = tidyCategoryName(input);
  if (name === '') return { ok: false, error: 'blank' };
  if (CONTROL_CHARACTERS.test(name)) return { ok: false, error: 'invalid_characters' };
  if ([...name].length > CATEGORY_NAME_MAX_LENGTH) return { ok: false, error: 'too_long' };
  const existing = registry.find(name);
  if (existing !== undefined) return { ok: false, error: 'duplicate', existing };
  return { ok: true, name };
}

export interface CustomCategoryInput {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly colour: string;
}

export interface CategoryRegistry {
  /** Every category, built-in first, then custom, then history labels. */
  readonly all: readonly CategoryDefinition[];
  /** Finds a category by name, ignoring case and spacing. */
  find(name: string): CategoryDefinition | undefined;
  /** True if `name` is exactly the stored name of a category (what an expense may be saved with). */
  isSelectable(name: string): boolean;
}

/**
 * Builds the registry. Built-ins win over custom definitions with the same
 * key, and both win over history labels, so a name never appears twice.
 * History labels (categories typed into the sheet, or created on another
 * phone before their definition arrived) keep their exact text.
 */
export function buildCategoryRegistry(
  custom: readonly CustomCategoryInput[],
  historyLabels: readonly string[],
): CategoryRegistry {
  const byKey = new Map<string, CategoryDefinition>();
  const add = (definition: CategoryDefinition) => {
    const key = categoryKey(definition.name);
    if (key !== '' && !byKey.has(key)) byKey.set(key, definition);
  };
  for (const builtIn of BUILT_IN_CATEGORIES) add({ ...builtIn, source: 'built_in' });
  for (const item of custom) {
    add({
      id: item.id,
      name: tidyCategoryName(item.name),
      icon: iconOrDefault(item.icon),
      colour: isCategoryColour(item.colour) ? item.colour : colourForName(item.name),
      source: 'custom',
    });
  }
  for (const label of historyLabels) {
    if (tidyCategoryName(label) === '') continue;
    add({ id: `label:${categoryKey(label)}`, name: label, icon: DEFAULT_CATEGORY_ICON, colour: colourForName(label), source: 'history' });
  }
  const all = [...byKey.values()];
  const names = new Set(all.map((definition) => definition.name));
  return {
    all,
    find: (name) => byKey.get(categoryKey(name)),
    isSelectable: (name) => names.has(name),
  };
}

/** Built-ins only (before setup, or until custom categories have loaded). */
export const BUILT_IN_REGISTRY: CategoryRegistry = buildCategoryRegistry([], []);

function compareNames(a: string, b: string): number {
  const ka = categoryKey(a);
  const kb = categoryKey(b);
  if (ka !== kb) return ka < kb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Picker order: alphabetical (ignoring case), with Other last. */
export function pickerOrder(registry: CategoryRegistry): CategoryDefinition[] {
  return [...registry.all].sort((a, b) => {
    const ao = a.id === 'other' ? 1 : 0;
    const bo = b.id === 'other' ? 1 : 0;
    return ao - bo || compareNames(a.name, b.name);
  });
}

/** Case-insensitive search on names (spacing-insensitive too). */
export function searchCategories(ordered: readonly CategoryDefinition[], query: string): CategoryDefinition[] {
  const needle = categoryKey(query);
  if (needle === '') return [...ordered];
  return ordered.filter((definition) => categoryKey(definition.name).includes(needle));
}

export interface CategoryUsage {
  /** The label as stored on the expenses. */
  readonly category: string;
  /** Number of distinct expenses (by ID) in the window. */
  readonly count: number;
}

/**
 * The quick-access categories: the most used in the window by number of
 * expenses (not amount), then the defaults to fill the remaining places.
 * Ties go to the default order, then the name, so the result never depends
 * on query order.
 */
export function rankQuickCategories(
  usage: readonly CategoryUsage[],
  registry: CategoryRegistry,
  limit = QUICK_CATEGORY_LIMIT,
): string[] {
  const counts = new Map<string, number>();
  for (const { category, count } of usage) {
    const definition = registry.find(category);
    if (definition === undefined || count <= 0) continue;
    counts.set(definition.name, (counts.get(definition.name) ?? 0) + count);
  }
  const defaultRank = (name: string) => {
    const index = DEFAULT_QUICK_CATEGORIES.indexOf(name);
    return index === -1 ? DEFAULT_QUICK_CATEGORIES.length : index;
  };
  const used = [...counts.entries()]
    .sort(([a, ca], [b, cb]) => cb - ca || defaultRank(a) - defaultRank(b) || compareNames(a, b))
    .map(([name]) => name);
  const result = used.slice(0, limit);
  for (const name of DEFAULT_QUICK_CATEGORIES) {
    if (result.length >= limit) break;
    if (!result.includes(name)) result.push(name);
  }
  return result;
}

/** A category definition row read from the Categories tab, or null if it is not usable. */
export function parseCategoryRow(cells: readonly unknown[]): CustomCategoryInput | null {
  const text = (index: number) => {
    const value = cells[index];
    return value === undefined || value === null ? '' : String(value);
  };
  const id = text(0).trim();
  const name = tidyCategoryName(text(1));
  if (id === '' || id.length > 64 || name === '' || [...name].length > CATEGORY_NAME_MAX_LENGTH) return null;
  if (CONTROL_CHARACTERS.test(name)) return null;
  return {
    id,
    name,
    icon: iconOrDefault(text(2).trim()),
    colour: isCategoryColour(text(3).trim()) ? text(3).trim() : colourForName(name),
  };
}
