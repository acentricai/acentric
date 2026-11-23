// While a new version upgrades the database, its port says so: a server that is upgrading is
// told from one that died, and the server takes the port once it is done.

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { SCHEMA_VERSION } from '@acentric/store';

import { listBackups } from '../src/backups/schedule.ts';
import { readSettings, start } from '../src/index.ts';
import { holdPort } from '../src/upgrading.ts';

const folders: string[] = [];
afterAll(() => {
  for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true });
});

/** A port no one has, now. */
const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

describe('a port held while the database is upgraded', () => {
  it('says the process is there, that it takes no request yet, and why', async () => {
    const port = await freePort();
    const held = await holdPort({ host: '127.0.0.1', port, version: '0.16.0' });
    const url = `http://127.0.0.1:${String(port)}`;
    try {
      const live = await fetch(`${url}/health/live`);
      expect(live.status).toBe(200);
      expect(await live.json()).toEqual({ ok: true, version: '0.16.0', upgrading: true });

      const health = await fetch(`${url}/health`);
      expect(health.status).toBe(503);
      expect(await health.json()).toEqual({ ok: false, version: '0.16.0', upgrading: true });

      const api = await fetch(`${url}/v1/agents`);
      expect(api.status).toBe(503);
      expect(api.headers.get('retry-after')).toBe('30');
      expect(await api.json()).toMatchObject({
        error: {
          code: 'unavailable',
          message: 'The server is upgrading its database to 0.16.0, and answers once it has',
        },
      });
    } finally {
      await held.close();
    }
    // Let go of, it is the server's to take.
    const again = await holdPort({ host: '127.0.0.1', port, version: '0.16.0' });
    await again.close();
  });

  it('is let go of for the server once the database is upgraded', async () => {
    const data = mkdtempSync(join(tmpdir(), 'acentric-upgrading-'));
    folders.push(data);
    const env = {
      ACENTRIC_DATA: data,
      ACENTRIC_ADMIN_KEY: 'test-admin-key-of-24-chars-or-more',
      ACENTRIC_CODE_PROCESSES: '1',
    };
    const options = { version: '0.15.0', log: () => {} };
    await (await start(readSettings({ ...env, ACENTRIC_PORT: '0' }), options)).close();

    // A version whose database is a schema on: the port is held, a backup taken, and the
    // server answers on that port when it is done.
    const port = await freePort();
    const server = await start(readSettings({ ...env, ACENTRIC_PORT: String(port) }), {
      ...options,
      version: '0.16.0',
      schema: SCHEMA_VERSION + 1,
    });
    try {
      expect(server.server.port).toBe(port);
      const health = await fetch(`http://127.0.0.1:${String(port)}/health`);
      expect(await health.json()).toEqual({ ok: true, version: '0.16.0' });
      const live = await fetch(`http://127.0.0.1:${String(port)}/health/live`);
      expect(live.status).toBe(200);
      const [taken] = await listBackups(join(data, 'backups'));
      expect(taken).toMatchObject({ kind: 'before-upgrade', version: '0.16.0' });
    } finally {
      await server.close();
    }
  }, 60_000);
});
