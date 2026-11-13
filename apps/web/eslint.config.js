import { createConfig } from '@ponctua/config/eslint';

export default [
  ...createConfig({ tsconfigRootDir: import.meta.dirname, env: 'browser', react: true }),
  {
    rules: {
      // Rule 3: OAuth tokens never reach the browser, sealed or not.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@ponctua/vault', '@ponctua/vault/*', '@ponctua/db', '@ponctua/db/*'],
              message:
                'Server-only package: the web app talks to the API, never to the vault or the database.',
            },
          ],
        },
      ],
    },
  },
];
