import { createConfig } from '@app/config/eslint';

export default [
  ...createConfig({ tsconfigRootDir: import.meta.dirname }),
  {
    rules: {
      // ADR 006: the API may seal OAuth tokens but must never be able to read them back.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@app/vault/open',
              message: 'Only the worker may open sealed tokens (ADR 006). Use @app/vault/seal.',
            },
          ],
        },
      ],
    },
  },
];
