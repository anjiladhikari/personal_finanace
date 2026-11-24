import { dataScopeOf, getAppSettings, isSetupComplete } from '@/db/appSettings';
import {
  listUnsyncedCategories,
  markCategorySynced,
  mergeRemoteCategories,
  setCategoriesMerged,
} from '@/db/categories';
import type { SqlDatabase } from '@/db/sql';
import { BUILT_IN_CATEGORIES, categoryKey, parseCategoryRow, type CustomCategoryInput } from '@/domain/categories';
import type { SubmissionErrorCode } from '@/domain/expense';
import {
  a1Range,
  APP_PROPERTY_CATEGORIES_TAB_ID,
  CATEGORIES_TAB_TITLE,
  CATEGORY_COLUMNS,
  inspectCategoriesTab,
  taggedCategoriesTabId,
} from '@/domain/sheetContract';
import { ATTEMPT_TIMEOUT_MS } from '@/domain/submissionPolicy';
import type { GoogleAuthorizer } from '@/google/authorization';
import { setAppProperties, type DriveFile } from '@/google/drive';
import type { FetchLike } from '@/google/http';
import type { GoogleSession } from '@/google/session';
import { appendRow, batchUpdate, getTabs, getValues, updateValues } from '@/google/sheets';

import { accessFailure, openSheetAccess } from './sheetAccess';

export interface CategorySyncDeps {
  readonly db: SqlDatabase;
  readonly authorizer: GoogleAuthorizer;
  readonly fetch: FetchLike;
  readonly isOnline: () => Promise<boolean>;
  readonly now: () => number;
}

export type CategorySyncOutcome =
  | { readonly kind: 'skipped' }
  | { readonly kind: 'synced'; readonly restored: number; readonly uploaded: number }
  | { readonly kind: 'failed'; readonly code: SubmissionErrorCode | 'categories_tab_changed' };

class CategoriesTabChanged extends Error {}

const RESERVED_KEYS: ReadonlySet<string> = new Set(BUILT_IN_CATEGORIES.map((c) => categoryKey(c.name)));

interface Tab {
  readonly sheetId: number;
  readonly title: string;
}

function freeTitle(taken: ReadonlySet<string>): string {
  if (!taken.has(CATEGORIES_TAB_TITLE)) return CATEGORIES_TAB_TITLE;
  for (let n = 2; ; n += 1) {
    const title = `${CATEGORIES_TAB_TITLE} ${n}`;
    if (!taken.has(title)) return title;
  }
}

/**
 * Finds the Categories tab by the sheetId recorded in Drive app properties.
 * With `create`, makes it (with its header) the first time something needs
 * backing up; otherwise returns null when there is none, so a spreadsheet
 * only gains the tab once the user has a category of their own. A tab left
 * by an interrupted creation (our title and header, but no recorded ID) is
 * adopted rather than duplicated. The header is checked before any use.
 */
async function findCategoriesTab(
  session: GoogleSession,
  spreadsheetId: string,
  file: DriveFile,
  create: boolean,
): Promise<Tab | null> {
  const tabs = await getTabs(session, spreadsheetId);
  const taggedId = taggedCategoriesTabId(file.appProperties);
  let tab: Tab | undefined = tabs.find((t) => t.sheetId === taggedId);

  if (tab === undefined) {
    const titled = tabs.find((t) => t.title === CATEGORIES_TAB_TITLE);
    const adoptable =
      titled !== undefined &&
      inspectCategoriesTab(await getValues(session, spreadsheetId, a1Range(titled.title, 'A1:E2'))).kind === 'ready';
    if (adoptable) {
      tab = titled;
    } else if (!create) {
      return null;
    } else {
      const title = freeTitle(new Set(tabs.map((t) => t.title)));
      const reply = await batchUpdate(session, spreadsheetId, [
        { addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } },
      ]);
      const sheetId = reply.replies?.[0]?.addSheet?.properties?.sheetId;
      if (typeof sheetId !== 'number') throw new Error('Sheets did not return the new tab');
      tab = { sheetId, title };
    }
    await setAppProperties(session, spreadsheetId, { [APP_PROPERTY_CATEGORIES_TAB_ID]: String(tab.sheetId) });
  }

  const inspection = inspectCategoriesTab(await getValues(session, spreadsheetId, a1Range(tab.title, 'A1:E2')));
  if (inspection.kind === 'empty') {
    await updateValues(session, spreadsheetId, a1Range(tab.title, 'A1:E1'), [[...CATEGORY_COLUMNS]]);
  } else if (inspection.kind === 'invalid') {
    throw new CategoriesTabChanged();
  }
  return tab;
}

/**
 * Backs up and restores custom category definitions through the Categories
 * tab. Reads the tab first, so a retry after a lost response finds the row it
 * already wrote (matched by Category ID) instead of appending it again.
 * Without `force` it runs only when a definition is waiting to be backed up;
 * `force` (after connecting Google, and with a full refresh) also restores
 * definitions saved from other installs.
 */
export async function syncCategories(deps: CategorySyncDeps, options: { readonly force: boolean }): Promise<CategorySyncOutcome> {
  const settings = await getAppSettings(deps.db);
  const scope = dataScopeOf(settings);
  if (!isSetupComplete(settings) || scope === null) return { kind: 'skipped' };

  const waiting = await listUnsyncedCategories(deps.db, scope);
  if (!options.force && waiting.length === 0) return { kind: 'skipped' };
  if (!(await deps.isOnline())) return { kind: 'failed', code: 'offline' };

  const access = await openSheetAccess(deps, settings, scope);
  if (access.kind !== 'ready') return { kind: 'failed', code: access.error.code };

  try {
    const tab = await findCategoriesTab(access.session, scope.spreadsheetId, access.file, waiting.length > 0);
    if (tab === null) {
      // Nothing saved in this spreadsheet yet, and nothing to back up.
      await setCategoriesMerged(deps.db, scope.spreadsheetId);
      return { kind: 'synced', restored: 0, uploaded: 0 };
    }
    const rows = await getValues(access.session, scope.spreadsheetId, a1Range(tab.title, 'A2:E'));
    const remote = rows.map(parseCategoryRow).filter((row): row is CustomCategoryInput => row !== null);
    const now = new Date(deps.now()).toISOString();
    const restored = await mergeRemoteCategories(deps.db, scope, remote, RESERVED_KEYS, now);

    const remoteIds = new Set(remote.map((r) => r.id));
    const remoteKeys = new Set(remote.map((r) => categoryKey(r.name)));
    let uploaded = 0;
    for (const category of await listUnsyncedCategories(deps.db, scope)) {
      if (!remoteIds.has(category.id) && !remoteKeys.has(categoryKey(category.name))) {
        // RAW: the name is stored as literal text, never as a formula or number.
        await appendRow(
          access.session,
          scope.spreadsheetId,
          a1Range(tab.title, 'A1:E1'),
          [category.id, category.name, category.icon, category.colour, category.createdAt],
          ATTEMPT_TIMEOUT_MS,
        );
        uploaded += 1;
      }
      await markCategorySynced(deps.db, category.id, scope.spreadsheetId, new Date(deps.now()).toISOString());
    }
    await setCategoriesMerged(deps.db, scope.spreadsheetId);
    return { kind: 'synced', restored, uploaded };
  } catch (error) {
    if (error instanceof CategoriesTabChanged) return { kind: 'failed', code: 'categories_tab_changed' };
    return { kind: 'failed', code: accessFailure(error).error.code };
  }
}
