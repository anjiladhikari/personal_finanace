import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { dataScopeOf } from '@/db/appSettings';
import { categoryUsage, listCustomCategories, listExpenseCategoryLabels } from '@/db/categories';
import { onCategoriesChanged, onSubmissionsChanged } from '@/db/changes';
import { useDatabase } from '@/db/DatabaseContext';
import { useAppSettings } from '@/db/useAppSettings';
import {
  BUILT_IN_REGISTRY,
  buildCategoryRegistry,
  QUICK_CATEGORY_WINDOW_DAYS,
  type CategoryRegistry,
  type CategoryUsage,
} from '@/domain/categories';
import { addDays, todayLocalDate } from '@/domain/dates';
import type { DataScope } from '@/domain/expense';

/**
 * The one category registry the app uses: the picker, validation, saving
 * and the charts all read it from here. Built-ins only until custom
 * categories and expense labels have loaded (or before setup).
 */
const RegistryContext = createContext<CategoryRegistry>(BUILT_IN_REGISTRY);

const scopeKey = (scope: DataScope | null) => (scope === null ? '' : `${scope.accountId}\n${scope.spreadsheetId}`);

export function CategoryRegistryProvider({ children }: { readonly children: ReactNode }) {
  const db = useDatabase();
  const settings = useAppSettings();
  const scope = useMemo(() => (settings.status === 'ready' ? dataScopeOf(settings.settings) : null), [settings]);
  const [loaded, setLoaded] = useState<{ readonly key: string; readonly registry: CategoryRegistry } | null>(null);

  useEffect(() => {
    if (scope === null) return undefined;
    let active = true;
    const key = scopeKey(scope);
    const load = () => {
      Promise.all([listCustomCategories(db, scope.accountId), listExpenseCategoryLabels(db, scope)]).then(
        ([custom, labels]) => active && setLoaded({ key, registry: buildCategoryRegistry(custom, labels) }),
        () => undefined,
      );
    };
    load();
    const offCategories = onCategoriesChanged(load);
    // New expense labels arrive with saves and refreshes.
    const offSubmissions = onSubmissionsChanged(load);
    return () => {
      active = false;
      offCategories();
      offSubmissions();
    };
  }, [db, scope]);

  const registry = loaded !== null && loaded.key === scopeKey(scope) ? loaded.registry : BUILT_IN_REGISTRY;
  return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>;
}

export function useCategoryRegistry(): CategoryRegistry {
  return useContext(RegistryContext);
}

/**
 * How many expenses used each category label in the last 90 days (purchase
 * date), counting each expense once by ID, including ones still waiting to
 * be sent. Empty until loaded.
 */
export function useCategoryUsage(scope: DataScope | null): readonly CategoryUsage[] {
  const db = useDatabase();
  const [usage, setUsage] = useState<{ readonly key: string; readonly rows: readonly CategoryUsage[] } | null>(null);

  useEffect(() => {
    if (scope === null) return undefined;
    let active = true;
    const key = scopeKey(scope);
    const load = () => {
      const today = todayLocalDate();
      categoryUsage(db, scope, addDays(today, -(QUICK_CATEGORY_WINDOW_DAYS - 1)), today).then(
        (rows) => active && setUsage({ key, rows }),
        () => undefined,
      );
    };
    load();
    const off = onSubmissionsChanged(load);
    return () => {
      active = false;
      off();
    };
  }, [db, scope]);

  return usage !== null && usage.key === scopeKey(scope) ? usage.rows : [];
}
