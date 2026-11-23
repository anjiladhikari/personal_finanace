/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  // Runs in the parent process before workers start, so every worker
  // inherits a non-UTC zone and calendar-date bugs show up in tests.
  globalSetup: '<rootDir>/test/globalSetup.js',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // Metro bundles this package from its TypeScript source ("react-native"
    // field); its compiled entry needs tslib, which it does not declare.
    '^react-native-gifted-charts$': '<rootDir>/node_modules/react-native-gifted-charts/src/index',
  },
  testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/src/**/*.test.tsx'],
};
