import { createConfig } from '@ponctua/config/eslint';

export default [
  ...createConfig({ tsconfigRootDir: import.meta.dirname }),
  {
    files: ['src/**/*.ts'],
    rules: {
      // ADR 006: the API may seal OAuth tokens but must never be able to read them back.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@ponctua/vault/open',
              message: 'Only the worker may open sealed tokens (ADR 006). Use @ponctua/vault/seal.',
            },
          ],
        },
      ],
    },
  },
];
