// What workerd is started with: none of the engine's environment, where its keys are. A
// stand-in for workerd writes what its shell exports, then exits, so the start fails.

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, expect, it } from 'vitest';

import { Sandbox } from '../src/isolate/sandbox.ts';

/** What a shell exports of its own with an empty environment (`_` is bash's last argument). */
const THE_SHELLS = new Set(['OLDPWD', 'PWD', 'SHLVL', '_']);

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'acentric-environment-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

it('starts workerd with none of the engine’s environment', async () => {
  const files = join(dir, 'files');
  await mkdir(files);
  await writeFile(join(files, 'host.js'), '');
  await writeFile(join(files, 'shim.js'), '');
  const report = join(dir, 'exported');
  const binary = join(dir, 'workerd');
  await writeFile(binary, `#!/bin/sh\nexport -p > '${report}'\nexit 1\n`);
  await chmod(binary, 0o755);

  process.env['ENGINE_SECRET'] = 'not for agents';
  try {
    await expect(
      Sandbox.start({
        binary,
        files,
        network: { reach: 'any' },
        compatibilityDate: '2026-01-01',
        startTimeoutMs: 10_000,
        log: () => {},
        onLost: () => {},
        onRejected: () => {},
        loadConcurrency: 1,
      }),
    ).rejects.toThrow(/workerd exited/);
  } finally {
    delete process.env['ENGINE_SECRET'];
  }

  const names = (await readFile(report, 'utf8'))
    .split('\n')
    .filter((line) => line.startsWith('export '))
    .map((line) => line.slice('export '.length).split('=')[0] ?? '');
  expect(names.length).toBeGreaterThan(0);
  expect(names.filter((name) => !THE_SHELLS.has(name))).toEqual([]);
});
