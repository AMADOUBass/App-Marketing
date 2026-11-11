import { createConfig } from '@app/config/eslint';

export default createConfig({ tsconfigRootDir: import.meta.dirname, env: 'browser', react: true });
