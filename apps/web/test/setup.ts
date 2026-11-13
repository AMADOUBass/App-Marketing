import { configure } from '@testing-library/react';

// `pnpm check` runs every package at once (API tests start PostgreSQL containers): on a busy machine
// the first render of a file can take more than Testing Library's default 1 s. Waiting longer only
// slows down a test that is failing anyway.
configure({ asyncUtilTimeout: 5000 });
