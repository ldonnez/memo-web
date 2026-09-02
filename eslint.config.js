import globals from 'globals';

export default [
  {
    ignores: ['package-lock.json', 'node_modules/', '.github/', 'dist/'],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.es2024,
        // Web APIs not in globals.browser
        MutationObserver: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
      'no-var': 'error',
      'prefer-const': 'warn',
      'no-undef': 'error',
    },
  },
  {
    files: ['specs/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
];
