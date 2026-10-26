// The pure entry must bundle into an agent's pure half, which acentric build
// refuses if it imports anything or reaches I/O, the clock or randomness.

import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));

describe('the pure entry', () => {
  it('bundles with no imports, I/O, timers, clock or randomness', async () => {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      platform: 'neutral',
      format: 'esm',
      write: false,
      logLevel: 'silent',
    });
    const code = result.outputFiles[0]?.text ?? '';
    const exported = /export \{([^}]*)\}/.exec(code)?.[1] ?? '';
    expect(exported).toContain('LlmError');
    expect(exported).toContain('pendingToolCalls');
    expect(exported).toContain('convert');
    expect(exported).toContain('MODELS');
    expect(code).not.toMatch(/^\s*import\s/m);
    for (const name of [
      'fetch',
      'setTimeout',
      'setInterval',
      'Date.now',
      'Math.random',
      'process.',
    ]) {
      expect(code, name).not.toContain(name);
    }
  });

  it('leaves the client to handlers, which it bundles for with nothing but the web platform', async () => {
    const client = fileURLToPath(new URL('../src/client.ts', import.meta.url));
    const result = await build({
      entryPoints: [client],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      logLevel: 'silent',
    });
    const code = result.outputFiles[0]?.text ?? '';
    expect(code).toContain('fetch');
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).not.toContain('node:');
    expect(code).not.toContain('process.');
  });
});
