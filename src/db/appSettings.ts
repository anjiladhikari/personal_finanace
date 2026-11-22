import { DiagnosticError } from '@/diagnostics/log';
import type { DataScope } from '@/domain/expense';
import { isValidCurrencyConfig, type CurrencyConfig } from '@/domain/money';

import type { SqlDatabase } from './sql';

export interface AppSettings {
  readonly schemaVersion: number;
  readonly currency: CurrencyConfig;
  /** Stable Google account identifier (OpenID `sub`), not an email or token. */
  readonly googleAccountId: string | null;
  /** Account hint for Google authorization and for display only. */
  readonly googleAccountEmail: string | null;
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
  google_account_email: string | null;
  spreadsheet_id: string | null;
  expenses_sheet_id: number | null;
  last_successful_sync_at: string | null;
}

export async function getAppSettings(db: SqlDatabase): Promise<AppSettings> {
  const row = await db.getFirst<AppSettingsRow>(
    `SELECT schema_version, currency_code, currency_minor_units, google_account_id,
            google_account_email, spreadsheet_id, expenses_sheet_id, last_successful_sync_at
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
    googleAccountEmail: row.google_account_email,
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

/** Setup is complete when an account, its spreadsheet and the Expenses tab are bound. */
export function isSetupComplete(settings: AppSettings): boolean {
  return (
    settings.googleAccountId !== null &&
    settings.spreadsheetId !== null &&
    settings.expensesSheetId !== null
  );
}

export interface AccountIdentity {
  readonly accountId: string;
  readonly email: string;
}

/**
 * Binds this phone to a Google account. Re-binding the same account only
 * refreshes the email. Binding a different account is refused unless
 * `switchAccount` is set, and switching clears the spreadsheet binding (the
 * old spreadsheet belongs to the old account). Callers must check there are
 * no pending submissions before switching.
 */
export async function bindGoogleAccount(
  db: SqlDatabase,
  identity: AccountIdentity,
  options: { readonly switchAccount: boolean },
): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await tx.getFirst<{ google_account_id: string | null }>(
      'SELECT google_account_id FROM app_settings WHERE id = ?',
      [1],
    );
    const boundId = current?.google_account_id ?? null;
    if (boundId === null || boundId === identity.accountId) {
      await tx.run(
        'UPDATE app_settings SET google_account_id = ?, google_account_email = ? WHERE id = ?',
        [identity.accountId, identity.email, 1],
      );
      return;
    }
    if (!options.switchAccount) {
      throw new Error('A different Google account is already bound');
    }
    const pending = await tx.getFirst<{ n: number }>(
      'SELECT COUNT(*) AS n FROM pending_submissions WHERE account_id = ?',
      [boundId],
    );
    if ((pending?.n ?? 0) > 0) {
      throw new Error('Cannot switch accounts while expenses are waiting to be saved');
    }
    await tx.run(
      `UPDATE app_settings
       SET google_account_id = ?, google_account_email = ?, spreadsheet_id = NULL,
           expenses_sheet_id = NULL, last_successful_sync_at = NULL
       WHERE id = ?`,
      [identity.accountId, identity.email, 1],
    );
  });
}

/**
 * Binds the spreadsheet and its Expenses tab for the already-bound account.
 * If it replaces a different spreadsheet of the same account, that account's
 * pending submissions move with it (a database trigger rejects moving rows
 * that belong to any other account).
 */
export async function bindSpreadsheet(
  db: SqlDatabase,
  binding: { readonly accountId: string; readonly spreadsheetId: string; readonly expensesSheetId: number },
): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await tx.getFirst<{ google_account_id: string | null; spreadsheet_id: string | null }>(
      'SELECT google_account_id, spreadsheet_id FROM app_settings WHERE id = ?',
      [1],
    );
    if (current?.google_account_id !== binding.accountId) {
      throw new Error('Spreadsheet does not belong to the bound Google account');
    }
    const previous = current.spreadsheet_id;
    if (previous !== null && previous !== binding.spreadsheetId) {
      await tx.run(
        'UPDATE pending_submissions SET spreadsheet_id = ? WHERE account_id = ? AND spreadsheet_id = ?',
        [binding.spreadsheetId, binding.accountId, previous],
      );
    }
    await tx.run(
      'UPDATE app_settings SET spreadsheet_id = ?, expenses_sheet_id = ? WHERE id = ? AND google_account_id = ?',
      [binding.spreadsheetId, binding.expensesSheetId, 1, binding.accountId],
    );
  });
}
