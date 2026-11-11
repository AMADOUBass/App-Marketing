import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface TsConfigFile {
  extends?: string;
  compilerOptions?: Record<string, unknown>;
}

const presetsDir = join(import.meta.dirname, '..', 'tsconfig');

function readPreset(name: string): TsConfigFile {
  return JSON.parse(readFileSync(join(presetsDir, name), 'utf8')) as TsConfigFile;
}

/** Resolves the `extends` chain (local presets only) and merges compilerOptions. */
function resolvedOptions(name: string): Record<string, unknown> {
  const preset = readPreset(name);
  const parent = preset.extends ? resolvedOptions(preset.extends.replace('./', '')) : {};
  return { ...parent, ...preset.compilerOptions };
}

// These flags are required by CLAUDE.md (section 8). Weakening them must be a deliberate ADR,
// not a silent edit, so this test fails if any preset loses them.
const requiredStrictFlags = {
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noImplicitOverride: true,
} as const;

describe.each(['base.json', 'node.json', 'nest.json', 'react.json'])(
  'tsconfig preset %s',
  (name) => {
    it('keeps the mandatory strict flags', () => {
      expect(resolvedOptions(name)).toMatchObject(requiredStrictFlags);
    });
  },
);

describe('nest.json', () => {
  it('enables decorator metadata for NestJS dependency injection', () => {
    expect(resolvedOptions('nest.json')).toMatchObject({
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
    });
  });
});
