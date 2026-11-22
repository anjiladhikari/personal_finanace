/**
 * The only module allowed to write to the console (enforced by ESLint).
 *
 * Diagnostic fields are restricted to numbers, booleans and a closed set of
 * codes, so expense descriptions, amounts-as-text, account emails, sheet IDs
 * and tokens cannot be passed in. Values that slip past the type system
 * (e.g. through `any`) are redacted at runtime as well.
 */

export const DIAGNOSTIC_CODES = [
  'database_newer_than_app',
  'migration_failed',
  'database_open_failed',
  'invalid_settings',
  'unknown_error',
] as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

export type DiagnosticEvent =
  | 'db.migrated'
  | 'db.migration_failed'
  | 'db.open_failed'
  | 'app.render_failed';

export type DiagnosticValue = number | boolean | DiagnosticCode;

export type DiagnosticFields = Readonly<Record<string, DiagnosticValue>>;

const ALLOWED_CODES: ReadonlySet<string> = new Set(DIAGNOSTIC_CODES);
const SAFE_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,40}$/;

export type DiagnosticSink = (line: string) => void;

let sink: DiagnosticSink = (line) => console.info(line);

/** Test hook: replace the output sink. Returns a function that restores it. */
export function setDiagnosticSink(next: DiagnosticSink): () => void {
  const previous = sink;
  sink = next;
  return () => {
    sink = previous;
  };
}

function sanitize(fields: Readonly<Record<string, unknown>>): Record<string, DiagnosticValue | '[redacted]'> {
  const safe: Record<string, DiagnosticValue | '[redacted]'> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!SAFE_KEY.test(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) safe[key] = value;
    else if (typeof value === 'boolean') safe[key] = value;
    else if (typeof value === 'string' && ALLOWED_CODES.has(value)) safe[key] = value as DiagnosticCode;
    else safe[key] = '[redacted]';
  }
  return safe;
}

export function logDiagnostic(event: DiagnosticEvent, fields: DiagnosticFields = {}): void {
  sink(`[diag] ${event} ${JSON.stringify(sanitize(fields))}`);
}

/** Maps any thrown value to a code without reading its message. */
export function diagnosticCodeFor(error: unknown): DiagnosticCode {
  if (error instanceof DiagnosticError) return error.code;
  return 'unknown_error';
}

/**
 * An error whose message is a fixed, non-personal description. Use it for
 * failures that may surface in logs or error screens.
 */
export class DiagnosticError extends Error {
  readonly code: DiagnosticCode;

  constructor(code: DiagnosticCode, message: string) {
    super(message);
    this.name = 'DiagnosticError';
    this.code = code;
  }
}
