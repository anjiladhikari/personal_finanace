import { DiagnosticError, diagnosticCodeFor, logDiagnostic, setDiagnosticSink } from './log';

describe('logDiagnostic', () => {
  let lines: string[];
  let restore: () => void;

  beforeEach(() => {
    lines = [];
    restore = setDiagnosticSink((line) => lines.push(line));
  });

  afterEach(() => restore());

  test('emits numbers, booleans and known codes', () => {
    logDiagnostic('db.migrated', { fromVersion: 0, toVersion: 1, applied: 1, fresh: true });
    logDiagnostic('db.migration_failed', { code: 'migration_failed' });
    expect(lines).toEqual([
      '[diag] db.migrated {"fromVersion":0,"toVersion":1,"applied":1,"fresh":true}',
      '[diag] db.migration_failed {"code":"migration_failed"}',
    ]);
  });

  test('redacts free text that bypasses the type system', () => {
    const leaky = {
      description: 'Dinner with Sam',
      email: 'someone@example.com',
      token: 'ya29.a0AfB_secret',
      amount: '42.50',
      nan: Number.NaN,
      nested: { amountMinor: 4250 },
    } as unknown as Record<string, number>;

    logDiagnostic('db.open_failed', leaky);

    const output = lines.join('\n');
    expect(output).not.toMatch(/Dinner|Sam|example\.com|ya29|secret|42\.50|4250/);
    expect(output).toBe(
      '[diag] db.open_failed {"description":"[redacted]","email":"[redacted]","token":"[redacted]","amount":"[redacted]","nan":"[redacted]","nested":"[redacted]"}',
    );
  });

  test('drops keys that are not plain identifiers', () => {
    logDiagnostic('db.open_failed', { 'someone@example.com': 1, ok: 2 } as Record<string, number>);
    expect(lines).toEqual(['[diag] db.open_failed {"ok":2}']);
  });

  test('the type system rejects string fields', () => {
    // @ts-expect-error free-form strings are not DiagnosticValue
    logDiagnostic('db.open_failed', { description: 'Dinner with Sam' });
    expect(lines[0]).toContain('[redacted]');
  });
});

describe('diagnosticCodeFor', () => {
  test('never reads error messages', () => {
    expect(diagnosticCodeFor(new Error('UNIQUE failed for Dinner with Sam'))).toBe('unknown_error');
    expect(diagnosticCodeFor('raw string')).toBe('unknown_error');
    expect(diagnosticCodeFor(new DiagnosticError('database_newer_than_app', 'fixed text'))).toBe(
      'database_newer_than_app',
    );
  });
});
