import { DiagnosticError } from '@/diagnostics/log';
import type { DataScope } from '@/domain/expense';
import { isValidCurrencyConfig, type CurrencyConfig } from '@/domain/money';

import type { SqlDatabase } from './sql';

export interface AppSettings {
  readonly schemaVersion: number;
  readonly currency: CurrencyConfig;
  /** Stable Google account identifier (OpenID `sub`), not an email or token. */
  readonly googleAccountId: string | null;
  readonly spreadsheetId: string | null;
  /** Numeric sheetId of the Expenses tab inside the spreadsheet. */
  readonly expensesSheetId: number | null;
  /** UTC ISO-8601 instant of the last completed synchronisation. */
  readonly lastSuccessfulSyncAt: string | null;
}

interface AppSettingsRow {
  schema_version: number;
  currency_code: string;
  currency_minor_units: number;
  google_account_id: string | null;
  spreadsheet_id: string | null;
  expenses_sheet_id: number | null;
  last_successful_sync_at: string | null;
}

export async function getAppSettings(db: SqlDatabase): Promise<AppSettings> {
  const row = await db.getFirst<AppSettingsRow>(
    `SELECT schema_version, currency_code, currency_minor_units, google_account_id,
            spreadsheet_id, expenses_sheet_id, last_successful_sync_at
     FROM app_settings WHERE id = ?`,
    [1],
  );
  if (row === null) {
    throw new DiagnosticError('invalid_settings', 'App settings are missing');
  }
  const currency = { code: row.currency_code, minorUnits: row.currency_minor_units };
  if (!isValidCurrencyConfig(currency)) {
    throw new DiagnosticError('invalid_settings', 'Configured currency is invalid');
  }
  return {
    schemaVersion: row.schema_version,
    currency,
    googleAccountId: row.google_account_id,
    spreadsheetId: row.spreadsheet_id,
    expensesSheetId: row.expenses_sheet_id,
    lastSuccessfulSyncAt: row.last_successful_sync_at,
  };
}

/** The account + spreadsheet that local data belongs to, once setup is done. */
export function dataScopeOf(settings: AppSettings): DataScope | null {
  if (settings.googleAccountId === null || settings.spreadsheetId === null) return null;
  return { accountId: settings.googleAccountId, spreadsheetId: settings.spreadsheetId };
}
