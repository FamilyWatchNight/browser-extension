/*
Copyright (c) 2026 Steve Dwire

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, version 3.
*/

import reactPlugin from '@eslint-react/eslint-plugin';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import-x';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  // Ignore generated folders
  {
    ignores: ['dist/**', 'build/**', 'coverage/**'],
  },

  // Base JS recommendations
  js.configs.recommended,

  // TypeScript recommendations
  ...tseslint.configs.recommended,

  // Special handling for config files
  {
    files: ['**/*.{js,cjs,mjs}'],

    languageOptions: {
      globals: {
        ...globals.node,
      },
    },

    rules: {
      // Allow CommonJS require() in config files and scripts
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  {
    files: ['**/*.{ts,tsx}'],

    languageOptions: {
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },

    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
      import: importPlugin,
    },

    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // Stable import ordering
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],

          'newlines-between': 'always',

          alphabetize: {
            order: 'asc',
            caseInsensitive: true,
          },
        },
      ],
    },
  },

  // IMPORTANT:
  // Disables formatting rules that conflict with Prettier
  prettier,
];
