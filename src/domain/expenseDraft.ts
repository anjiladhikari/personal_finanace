import { validatePurchaseDate, type LocalDate, type PurchaseDateError } from './dates';
import { BUILT_IN_REGISTRY, type CategoryRegistry } from './categories';
import type { ExpensePayload } from './expense';
import { parseAmount, type AmountParseError } from './money';

/** What the form holds while the user types. */
export interface ExpenseDraft {
  readonly description: string;
  readonly amountText: string;
  readonly category: string | null;
  readonly purchaseDate: string;
}

export interface ExpenseDraftErrors {
  readonly description?: 'empty';
  readonly amount?: AmountParseError;
  readonly category?: 'missing';
  readonly purchaseDate?: PurchaseDateError;
}

export type DraftValidation =
  | { readonly ok: true; readonly payload: ExpensePayload }
  | { readonly ok: false; readonly errors: ExpenseDraftErrors };

export function emptyDraft(today: LocalDate): ExpenseDraft {
  return { description: '', amountText: '', category: null, purchaseDate: today };
}

export function validateExpenseDraft(
  draft: ExpenseDraft,
  context: {
    readonly minorUnits: number;
    readonly today: LocalDate;
    /** The categories an expense may use; built-ins only if omitted. */
    readonly categories?: CategoryRegistry;
  },
): DraftValidation {
  const registry = context.categories ?? BUILT_IN_REGISTRY;
  const category = draft.category !== null && registry.isSelectable(draft.category) ? draft.category : null;
  const errors: {
    description?: 'empty';
    amount?: AmountParseError;
    category?: 'missing';
    purchaseDate?: PurchaseDateError;
  } = {};

  const description = draft.description.trim();
  if (description === '') errors.description = 'empty';

  const amount = parseAmount(draft.amountText, context.minorUnits);
  if (!amount.ok) errors.amount = amount.error;

  if (category === null) errors.category = 'missing';

  const date = validatePurchaseDate(draft.purchaseDate, context.today);
  if (!date.ok) errors.purchaseDate = date.error;

  if (!amount.ok || !date.ok || category === null || description === '') {
    return { ok: false, errors };
  }
  return {
    ok: true,
    payload: {
      purchaseDate: date.date,
      description,
      amountMinor: amount.amountMinor,
      category,
    },
  };
}
