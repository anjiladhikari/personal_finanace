import { isExpenseCategory, type ExpenseCategory } from '@/domain/expense';

/**
 * Categorical chart colours. Each category keeps its colour in every period
 * and in both chart types. Seven colours cannot all be told apart pairwise
 * under colour-vision deficiency, so colour is never the only cue: every bar
 * and pie slice also carries its category name. Several sit below 3:1 on
 * white for the same reason they are always labelled.
 */
const SLOTS = ['#2A78D6', '#EB6834', '#1BAF7A', '#EDA100', '#E87BA4', '#008300', '#6250D6', '#E34948'] as const;

const FIXED: Readonly<Record<ExpenseCategory, string>> = {
  Groceries: SLOTS[0],
  'Eating out': SLOTS[1],
  Transport: SLOTS[2],
  Bills: SLOTS[3],
  Shopping: SLOTS[4],
  Health: SLOTS[5],
  Other: SLOTS[6],
};

/** Neutral grey for the aggregated pie slice; 3.5:1 on white. */
export const REMAINING_COLOR = '#8A8984';

function hashName(name: string): number {
  // FNV-1a over UTF-16 code units: the same name gives the same slot everywhere.
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * The app's own categories have fixed colours. A category typed directly in
 * the sheet gets a colour derived from its name, which is stable but may match
 * another category's colour; the name beside it tells them apart.
 */
export function categoryColor(category: string): string {
  if (isExpenseCategory(category)) return FIXED[category];
  return SLOTS[hashName(category) % SLOTS.length] ?? SLOTS[0];
}
