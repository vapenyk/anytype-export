import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Base TypeScript rules
  ...tseslint.configs.recommended,

  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    rules: {
      // ── TypeScript ────────────────────────────────────────────────────────
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],

      // ── Code quality ──────────────────────────────────────────────────────
      'no-console': 'off',           // CLI app — console is intentional
      'eqeqeq': ['error', 'always'], // no == 
      'no-throw-literal': 'error',   // throw new Error(), not throw "string"

      // ── Style ─────────────────────────────────────────────────────────────
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  {
    // Don't lint compiled output if it ever appears
    ignores: ['dist/**', '*.js'],
  }
);
