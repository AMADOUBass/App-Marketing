import { createConfig } from '@app/config/eslint';

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
              group: ['@app/vault', '@app/vault/*', '@app/db', '@app/db/*'],
              message:
                'Server-only package: the web app talks to the API, never to the vault or the database.',
            },
          ],
        },
      ],
    },
  },
];
