// The server's own backups, its lock on its data, and the backup commands of its program: on a
// real server, on a folder of its own.

import { spawn } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { Audit, MemoryStore } from '@acentric/core';
import { SCHEMA_VERSION } from '@acentric/store';

import { checkBackup } from '../src/backups/archive.ts';
import { DataInUse } from '../src/backups/lock.ts';
import { Backups, listBackups } from '../src/backups/schedule.ts';
import { readSettings, start } from '../src/index.ts';
import { backUpBeforeUpgrade } from '../src/start.ts';

const REPO = join(import.meta.dirname, '..', '..', '..');
const BIN = join(REPO, 'apps', 'server', 'dist', 'bin.js');
const ADMIN = 'test-admin-key-of-24-chars-or-more';
const SECRET = 'ab'.repeat(32);

const folders: string[] = [];
const folder = (): string => {
  const made = mkdtempSync(join(tmpdir(), 'acentric-backups-server-'));
  folders.push(made);
  return made;
};
afterAll(() => {
  for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true });
});

const env = (data: string, more: Record<string, string> = {}) => ({
  ACENTRIC_PORT: '0',
  ACENTRIC_DATA: data,
  ACENTRIC_ADMIN_KEY: ADMIN,
  ACENTRIC_SECRET_KEY: SECRET,
  ACENTRIC_CODE_PROCESSES: '1',
  ...more,
});
const serve = (data: string, more: Record<string, string> = {}) =>
  start(readSettings(env(data, more)), { version: '0.15.0', log: () => {} });

const call = async (url: string, path: string, method = 'GET') => {
  const answer = await fetch(`${url}${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN}` },
  });
  return { status: answer.status, body: (await answer.json()) as Record<string, unknown> };
};

/** Runs the server's program, with `input` on its stdin, and gives what it said. */
function run(
  args: string[],
  data: string,
  input?: string,
): Promise<{ code: number | null; out: Buffer; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, ...env(data) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => (err += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out: Buffer.concat(out), err }));
    if (input === undefined) child.stdin.end();
    else createReadStream(input).pipe(child.stdin);
  });
}

describe('a server on its folder of data', () => {
  it('has it alone: a second server, and a restore, are refused until it stops', async () => {
    const data = folder();
    const first = await serve(data);
    try {
      await expect(serve(data)).rejects.toThrow(DataInUse);
      const some = join(folder(), 'some.tar');
      writeFileSync(some, 'not looked at: the lock is checked first');
      const refused = await run(['restore', some], data);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain(`A server is running on ${data}`);
    } finally {
      await first.close();
    }
    const second = await serve(data);
    await second.close();
  }, 60_000);
});

describe('the server’s own backups', () => {
  it('say where they go and what became of the last, and one is taken when asked', async () => {
    const data = folder();
    const server = await serve(data);
    try {
      const before = await call(server.server.url, '/v1/backups');
      expect(before.status).toBe(200);
      expect(before.body).toMatchObject({
        dir: join(data, 'backups'),
        sameDisk: true,
        everyMs: 86_400_000,
        keep: 3,
        last: null,
        items: [],
      });
      expect(before.body['next']).toBeGreaterThan(Date.now());

      const made = await call(server.server.url, '/v1/backups', 'POST');
      expect(made.status).toBe(201);
      expect(made.body).toMatchObject({ kind: 'manual', version: '0.15.0' });
      const name = String(made.body['name']);
      expect(name).toMatch(/^acentric-.+-manual-0\.15\.0\.tar$/);

      const after = await call(server.server.url, '/v1/backups');
      expect(after.body['last']).toMatchObject({ ok: true, name });
      expect((after.body['items'] as unknown[]).length).toBe(1);
      // It is a whole backup, which opens with the server's key.
      const { manifest, missing } = await checkBackup(
        createReadStream(join(data, 'backups', name)),
        Object.keys(readSettings(env(data)).secretKeys?.keys ?? {}),
        folder(),
      );
      expect(manifest.kind).toBe('manual');
      expect(missing).toEqual([]);
      const audit = await call(server.server.url, '/v1/audit-events?action=backup.made');
      expect((audit.body['items'] as { detail: { name: string } }[])[0]?.detail.name).toBe(name);
    } finally {
      await server.close();
    }
  }, 60_000);

  it('are none, and the API says so, when they are off', async () => {
    const data = folder();
    const server = await serve(data, { ACENTRIC_BACKUP_EVERY: 'off' });
    try {
      const answer = await call(server.server.url, '/v1/backups');
      expect(answer.status).toBe(503);
      expect(JSON.stringify(answer.body)).toContain('ACENTRIC_BACKUP_EVERY is off');
    } finally {
      await server.close();
    }
  }, 60_000);

  it('include one before a new version changes the database, and none when it does not', async () => {
    const data = folder();
    await (await serve(data)).close();
    const settings = readSettings(env(data));
    expect(await backUpBeforeUpgrade(settings, '0.15.0', SCHEMA_VERSION)).toBe(false);
    expect(await backUpBeforeUpgrade(settings, '0.16.0', SCHEMA_VERSION + 1)).toBe(true);
    const [taken] = await listBackups(join(data, 'backups'));
    expect(taken).toMatchObject({ kind: 'before-upgrade', version: '0.16.0' });
    // None when they are off.
    const off = readSettings(env(data, { ACENTRIC_BACKUP_EVERY: 'off' }));
    expect(await backUpBeforeUpgrade(off, '0.16.0', SCHEMA_VERSION + 1)).toBe(false);
  }, 60_000);
});

describe('backups of a folder', () => {
  /** A folder of data a server has had. */
  const served = async (): Promise<string> => {
    const data = folder();
    await (await serve(data)).close();
    return data;
  };
  const backupsOf = (
    data: string,
    more: { keep?: number; clock?: () => number; audit?: Audit } = {},
  ) =>
    new Backups({
      data,
      dir: join(data, 'backups'),
      everyMs: 3_600_000,
      keep: more.keep ?? 3,
      version: '0.15.0',
      withoutRemovals: (work) => work(),
      log: () => {},
      ...(more.clock === undefined ? {} : { clock: more.clock }),
      ...(more.audit === undefined ? {} : { audit: more.audit }),
    });

  it('keep the newest of each kind, as many as are kept', async () => {
    const data = await served();
    let now = 1_795_305_600_000;
    const backups = backupsOf(data, { keep: 2, clock: () => now });
    for (let n = 0; n < 3; n += 1) {
      await backups.take('manual');
      now += 1000;
    }
    await backups.take('scheduled');
    const kept = await listBackups(join(data, 'backups'));
    expect(kept.map((file) => file.kind)).toEqual(['scheduled', 'manual', 'manual']);
    expect(kept[1]?.createdAt).toBe(now - 1000);
  }, 60_000);

  it('say what became of one that failed, in the audit log too', async () => {
    const data = folder();
    const store = new MemoryStore();
    const backups = backupsOf(data, { audit: new Audit({ store }) });
    await expect(backups.take('manual')).rejects.toThrow('There is no database in');
    expect(backups.last).toMatchObject({ ok: false });
    const { items } = await store.listAuditEvents({ limit: 10 });
    expect(items[0]).toMatchObject({ action: 'backup.failed', detail: { kind: 'manual' } });
  });

  it('are next taken once one is due, and not in the first minute', async () => {
    const data = await served();
    const now = 1_795_305_600_000;
    const backups = backupsOf(data, { clock: () => now });
    await backups.start();
    expect(backups.next).toBe(now + 60_000);
    await backups.close();
    // A scheduled one an hour old with one every hour: due now, so taken in a minute.
    mkdirSync(join(data, 'backups'), { recursive: true });
    writeFileSync(join(data, 'backups', 'acentric-2026-11-23T12-00-00Z-scheduled-0.15.0.tar'), '');
    const later = backupsOf(data, { clock: () => Date.parse('2026-11-23T12:30:00Z') });
    await later.start();
    expect(later.next).toBe(Date.parse('2026-11-23T13:00:00Z'));
    await later.close();
    expect(later.next).toBeNull();
  }, 60_000);
});

describe('the backup commands', () => {
  it('back up beside a running server to stdout, check it from stdin, and restore once it stopped', async () => {
    if (!existsSync(BIN)) throw new Error(`${BIN} is not built: run \`pnpm build\``);
    const data = folder();
    const server = await serve(data);
    const file = join(folder(), 'backup.tar');
    try {
      const taken = await run(['backup'], data);
      expect(taken.code).toBe(0);
      expect(taken.err).toContain('backed up');
      writeFileSync(file, taken.out);
      const checked = await run(['check-backup'], data, file);
      expect(checked.code).toBe(0);
      expect(checked.err).toContain('a whole manual backup of 0.15.0');
      // Not while a server runs on the data.
      const refused = await run(['restore', file], data);
      expect(refused.code).toBe(1);
    } finally {
      await server.close();
    }
    const restored = await run(['restore'], data, file);
    expect(restored.code).toBe(0);
    expect(restored.err).toContain(`restored the backup of 0.15.0`);
    expect(restored.err).toContain('what was there before is in');
    // And a server starts on what was put back.
    await (await serve(data)).close();
  }, 120_000);
});
