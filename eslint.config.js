import js from '@eslint/js'
import globals from 'globals'

export default [
  { ignores: ['node_modules/**', 'apps/**/dist/**', 'apps/**/node_modules/**'] },

  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  // The desktop renderer runs in a browser context, not Node.
  {
    files: ['src/renderer/**/*.js'],
    languageOptions: { globals: { ...globals.browser } },
  },
]
