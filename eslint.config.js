import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';

export default [
  {
    ignores: ['dist/**', 'logs/**', 'node_modules/**', 'test-results/**', '.playwright-mcp/**'],
  },
  js.configs.recommended,
  {
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-duplicate-imports': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-useless-concat': 'error',
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    files: ['**/*.{js,mjs,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
  },
  {
    files: ['ui/**', 'ui-react/**', 'e2e/**'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ['ui-react/**/*.jsx'],
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { react },
    rules: {
      'react/jsx-key': 'error',
      'react/jsx-no-target-blank': 'error',
      'react/jsx-uses-vars': 'error',
    },
  },
];
