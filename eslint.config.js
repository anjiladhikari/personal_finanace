// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

// SQL helpers (our SqlDatabase interface and the raw expo-sqlite API).
const SQL_METHODS =
  '/^(run|getFirst|getAll|execScript|runAsync|getFirstAsync|getAllAsync|execAsync|prepareAsync)$/';

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', 'android/*', 'ios/*', 'coverage/*', '.expo/*'],
  },
  {
    rules: {
      // Diagnostics go through src/diagnostics/log.ts, which only accepts
      // non-personal fields. Direct console output could leak expense data.
      'no-console': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: `CallExpression[callee.property.name=${SQL_METHODS}] > TemplateLiteral[expressions.length>0]`,
          message: 'Build SQL with bound parameters, not template-literal interpolation.',
        },
        {
          selector: `CallExpression[callee.property.name=${SQL_METHODS}] > BinaryExpression[operator='+']`,
          message: 'Build SQL with bound parameters, not string concatenation.',
        },
      ],
    },
  },
  {
    // Type-aware rules for async code: an un-awaited promise can silently
    // drop a save or a sync step.
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: __dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    files: ['src/diagnostics/log.ts'],
    rules: { 'no-console': 'off' },
  },
]);
