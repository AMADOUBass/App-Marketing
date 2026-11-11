// @ts-check
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Shared ESLint flat config with type-aware typescript-eslint rules.
 *
 * @param {object} options
 * @param {string} options.tsconfigRootDir Directory of the package's tsconfig.json (pass `import.meta.dirname`).
 * @param {'node' | 'browser'} [options.env] Runtime globals to expose. Defaults to `node`.
 * @param {boolean} [options.react] Adds the React hooks rules (web app and UI components).
 */
export function createConfig({ tsconfigRootDir, env = 'node', react = false }) {
  return defineConfig(
    globalIgnores(['**/dist/**', '**/coverage/**', '**/.turbo/**', '**/node_modules/**']),

    js.configs.recommended,
    tseslint.configs.strictTypeChecked,
    tseslint.configs.stylisticTypeChecked,
    ...(react ? [reactHooks.configs.flat.recommended] : []),

    {
      languageOptions: {
        globals: env === 'browser' ? globals.browser : globals.node,
        parserOptions: {
          projectService: true,
          tsconfigRootDir,
        },
      },
      linterOptions: {
        reportUnusedDisableDirectives: 'error',
      },
      rules: {
        // Logs go through pino (structured JSON), never console.
        'no-console': 'error',
        eqeqeq: ['error', 'always'],
        '@typescript-eslint/consistent-type-imports': [
          'error',
          { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
        ],
        '@typescript-eslint/no-import-type-side-effects': 'error',
        '@typescript-eslint/switch-exhaustiveness-check': 'error',
        // NestJS modules are empty classes carrying a @Module() decorator.
        '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
        ],
      },
    },

    // Plain JS config files are not part of a TS project: skip type-aware rules there.
    {
      files: ['**/*.{js,mjs,cjs}'],
      extends: [tseslint.configs.disableTypeChecked],
    },
  );
}
