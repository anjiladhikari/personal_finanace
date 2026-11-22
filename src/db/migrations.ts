import { DiagnosticError } from '@/diagnostics/log';

import type { SqlDatabase } from './sql';

export interface Migration {
  readonly version: number;
  readonly name: string;
  /** Constant DDL/DML. Each migration runs in one transaction. */
  readonly statements: readonly string[];
}

// Shared CHECK fragments (constant text, no user input).
const LOCAL_DATE_CHECK = (column: string) => `CHECK (date(${column}) IS ${column})`;
const UTC_TIMESTAMP_GLOB =
  "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'";

/**
 * Append-only list. Never edit a released migration; add a new version.
 *
 * Credentials (OAuth tokens) are deliberately absent from every table: the
 * Google authorization SDK caches and refreshes them. Only the account's
 * stable identifier is stored here.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    statements: [
      `CREATE TABLE IF NOT EXISTS app_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL CHECK (schema_version >= 0),
        currency_code TEXT NOT NULL CHECK (currency_code GLOB '[A-Z][A-Z][A-Z]'),
        currency_minor_units INTEGER NOT NULL CHECK (currency_minor_units BETWEEN 0 AND 4),
        google_account_id TEXT CHECK (google_account_id IS NULL OR length(google_account_id) > 0),
        spreadsheet_id TEXT CHECK (spreadsheet_id IS NULL OR length(spreadsheet_id) > 0),
        expenses_sheet_id INTEGER CHECK (expenses_sheet_id IS NULL OR expenses_sheet_id >= 0),
        last_successful_sync_at TEXT CHECK (
          last_successful_sync_at IS NULL OR last_successful_sync_at GLOB ${UTC_TIMESTAMP_GLOB}
        ),
        CHECK (spreadsheet_id IS NULL OR google_account_id IS NOT NULL),
        CHECK (expenses_sheet_id IS NULL OR spreadsheet_id IS NOT NULL)
      ) STRICT`,
      // Provisional V1 currency: AUD with 2 minor units.
      `INSERT OR IGNORE INTO app_settings (id, schema_version, currency_code, currency_minor_units)
       VALUES (1, 0, 'AUD', 2)`,

      `CREATE TABLE IF NOT EXISTS confirmed_expenses (
        expense_id TEXT PRIMARY KEY NOT NULL CHECK (length(expense_id) > 0),
        account_id TEXT NOT NULL CHECK (length(account_id) > 0),
        spreadsheet_id TEXT NOT NULL CHECK (length(spreadsheet_id) > 0),
        purchase_date TEXT NOT NULL ${LOCAL_DATE_CHECK('purchase_date')},
        description TEXT NOT NULL,
        amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
        category TEXT NOT NULL CHECK (length(category) > 0)
      ) STRICT`,
      `CREATE INDEX IF NOT EXISTS confirmed_expenses_scope_date
       ON confirmed_expenses (account_id, spreadsheet_id, purchase_date)`,

      `CREATE TABLE IF NOT EXISTS pending_submissions (
        submission_id TEXT PRIMARY KEY NOT NULL CHECK (length(submission_id) > 0),
        account_id TEXT NOT NULL CHECK (length(account_id) > 0),
        spreadsheet_id TEXT NOT NULL CHECK (length(spreadsheet_id) > 0),
        purchase_date TEXT NOT NULL ${LOCAL_DATE_CHECK('purchase_date')},
        description TEXT NOT NULL,
        amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
        category TEXT NOT NULL CHECK (length(category) > 0),
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK (state IN ('pending', 'sending', 'uncertain', 'blocked')),
        created_at TEXT NOT NULL CHECK (created_at GLOB ${UTC_TIMESTAMP_GLOB}),
        last_attempt_at TEXT CHECK (last_attempt_at IS NULL OR last_attempt_at GLOB ${UTC_TIMESTAMP_GLOB}),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code GLOB '[a-z]*'),
        last_error_http_status INTEGER CHECK (
          last_error_http_status IS NULL OR last_error_http_status BETWEEN 100 AND 599
        )
      ) STRICT`,
      `CREATE INDEX IF NOT EXISTS pending_submissions_scope_date
       ON pending_submissions (account_id, spreadsheet_id, purchase_date)`,
      `CREATE INDEX IF NOT EXISTS pending_submissions_state
       ON pending_submissions (state)`,
      // The payload is what gets appended to Sheets on every retry, so it must
      // never change after the row is created.
      `CREATE TRIGGER IF NOT EXISTS pending_submissions_payload_immutable
       BEFORE UPDATE ON pending_submissions
       FOR EACH ROW
       WHEN NEW.submission_id IS NOT OLD.submission_id
         OR NEW.account_id IS NOT OLD.account_id
         OR NEW.spreadsheet_id IS NOT OLD.spreadsheet_id
         OR NEW.purchase_date IS NOT OLD.purchase_date
         OR NEW.description IS NOT OLD.description
         OR NEW.amount_minor IS NOT OLD.amount_minor
         OR NEW.category IS NOT OLD.category
         OR NEW.created_at IS NOT OLD.created_at
       BEGIN
         SELECT RAISE(ABORT, 'pending submission payload is immutable');
       END`,
    ],
  },
  {
    version: 2,
    name: 'google_account_binding',
    statements: [
      // Email is kept only as the account hint for Google's authorization
      // request and for display. The identity key stays google_account_id.
      `ALTER TABLE app_settings ADD COLUMN google_account_email TEXT
         CHECK (google_account_email IS NULL OR length(google_account_email) > 0)`,
      // Pending rows may move to a replacement spreadsheet (e.g. the old file
      // was deleted), but only within the bound account, and never to
      // another account. Everything else in the payload stays immutable.
      `DROP TRIGGER IF EXISTS pending_submissions_payload_immutable`,
      `CREATE TRIGGER pending_submissions_payload_immutable
       BEFORE UPDATE ON pending_submissions
       FOR EACH ROW
       WHEN NEW.submission_id IS NOT OLD.submission_id
         OR NEW.account_id IS NOT OLD.account_id
         OR NEW.purchase_date IS NOT OLD.purchase_date
         OR NEW.description IS NOT OLD.description
         OR NEW.amount_minor IS NOT OLD.amount_minor
         OR NEW.category IS NOT OLD.category
         OR NEW.created_at IS NOT OLD.created_at
       BEGIN
         SELECT RAISE(ABORT, 'pending submission payload is immutable');
       END`,
      `CREATE TRIGGER pending_submissions_spreadsheet_same_account
       BEFORE UPDATE OF spreadsheet_id ON pending_submissions
       FOR EACH ROW
       WHEN NEW.spreadsheet_id IS NOT OLD.spreadsheet_id
         AND OLD.account_id IS NOT (SELECT google_account_id FROM app_settings WHERE id = 1)
       BEGIN
         SELECT RAISE(ABORT, 'pending submissions can only move within the bound Google account');
       END`,
    ],
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

export interface MigrationResult {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly applied: number;
}

function assertWellFormed(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error('Migrations must be numbered 1..n without gaps');
    }
  });
}

/** PRAGMA values cannot be bound; the version is a validated integer from code. */
function setUserVersionSql(version: number): string {
  if (!Number.isSafeInteger(version) || version < 0) throw new Error('Invalid schema version');
  return `PRAGMA user_version = ${version}`;
}

export async function readSchemaVersion(db: SqlDatabase): Promise<number> {
  const row = await db.getFirst<{ user_version: number }>('PRAGMA user_version');
  return row?.user_version ?? 0;
}

/**
 * Brings the schema to the latest version. Safe to call on every launch:
 * already-applied versions are skipped, and each migration commits together
 * with its PRAGMA user_version bump, so an interrupted run leaves the database
 * at the previous version and is retried next launch.
 */
export async function migrateDatabase(
  db: SqlDatabase,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<MigrationResult> {
  assertWellFormed(migrations);
  const latest = migrations[migrations.length - 1]?.version ?? 0;
  const fromVersion = await readSchemaVersion(db);

  if (fromVersion > latest) {
    throw new DiagnosticError(
      'database_newer_than_app',
      'The local database was created by a newer version of the app',
    );
  }

  let applied = 0;
  for (const migration of migrations) {
    if (migration.version <= fromVersion) continue;
    await db.transaction(async (tx) => {
      for (const statement of migration.statements) {
        await tx.execScript(statement);
      }
      await tx.execScript(setUserVersionSql(migration.version));
      await tx.run('UPDATE app_settings SET schema_version = ? WHERE id = 1', [migration.version]);
    });
    applied += 1;
  }

  return { fromVersion, toVersion: Math.max(fromVersion, latest), applied };
}
