/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  // Runs in the parent process before workers start, so every worker
  // inherits a non-UTC zone and calendar-date bugs show up in tests.
  globalSetup: '<rootDir>/test/globalSetup.js',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/src/**/*.test.tsx'],
};
