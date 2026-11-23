// The first key of a server that had none: in a file of its data's, for its user alone, and
// never in its log.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const BIN = join(import.meta.dirname, '..', 'dist', 'bin.js');
const folders: string[] = [];
afterAll(() => {
  for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true });
});

describe('the first key', () => {
  it('is written to the data, readable by the server’s user alone, and not logged', async () => {
    if (!existsSync(BIN)) throw new Error(`${BIN} is not built: run \`pnpm build\``);
    const data = mkdtempSync(join(tmpdir(), 'acentric-first-key-'));
    folders.push(data);
    const env = {
      ...process.env,
      ACENTRIC_PORT: '0',
      ACENTRIC_DATA: data,
      ACENTRIC_CODE_PROCESSES: '1',
    };
    delete env['ACENTRIC_ADMIN_KEY'];
    delete env['ACENTRIC_ADMIN_KEY_FILE'];
    const child = spawn(process.execPath, [BIN], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += String(chunk)));
    child.stderr.on('data', (chunk: Buffer) => (out += String(chunk)));
    try {
      await expect.poll(() => out, { timeout: 30_000 }).toContain('Copy it somewhere safe');
      const file = join(data, 'first-admin-key');
      const key = readFileSync(file, 'utf8').trim();
      expect(key).toMatch(/^ak_/);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(out).not.toContain(key);
      expect(out).toContain(`the first key, which may do everything, is in ${file}`);
      // It is a key that works.
      const url = /listening on (\S+)/.exec(out)?.[1];
      const me = await fetch(`${String(url)}/v1/me`, {
        headers: { authorization: `Bearer ${key}` },
      });
      expect(me.status).toBe(200);
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }, 60_000);
});
