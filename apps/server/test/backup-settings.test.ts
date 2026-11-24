// How the server backs itself up, set through the API: in place of the environment's settings,
// without a restart and over one, a bucket reached with a key of its own whose secret is kept
// sealed and never said.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { SCHEMA_VERSION } from '@acentric/store';

import { listBackups } from '../src/backups/schedule.ts';
import { readSettings, start } from '../src/index.ts';
import { backUpBeforeUpgrade } from '../src/start.ts';
import { fakeS3 } from './fake-s3.ts';
import type { FakeS3 } from './fake-s3.ts';

const ADMIN = 'test-admin-key-of-24-chars-or-more';
const SECRET = 'ab'.repeat(32);
const BUCKET_SECRET = 'the-secret-of-the-bucket';

const folders: string[] = [];
const folder = (): string => {
  const made = mkdtempSync(join(tmpdir(), 'acentric-backup-settings-'));
  folders.push(made);
  return made;
};
afterAll(() => {
  for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true });
});

const OFF = { ACENTRIC_BACKUP_EVERY: 'off' };
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

const call = async (url: string, path: string, method = 'GET', body?: unknown) => {
  const answer = await fetch(`${url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ADMIN}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: answer.status, body: (await answer.json()) as Record<string, unknown> };
};

const DAY = 86_400_000;

describe('backup settings set through the API', () => {
  let s3: FakeS3;
  beforeAll(async () => {
    s3 = await fakeS3();
    // Nothing of the environment's AWS credentials: the bucket is reached with its own key.
    vi.stubEnv('AWS_ACCESS_KEY_ID', '');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', '');
    vi.stubEnv('AWS_PROFILE', '');
    return async () => {
      vi.unstubAllEnvs();
      await s3.close();
    };
  });

  it('are the environment’s until set, turn backups on without a restart, and stay so over one', async () => {
    const data = folder();
    const first = await serve(data, OFF);
    const url = first.server.url;
    try {
      expect(await call(url, '/v1/backups/settings')).toMatchObject({
        status: 200,
        body: {
          source: 'environment',
          enabled: false,
          everyMs: DAY,
          keep: 3,
          dir: join(data, 'backups'),
          bucket: null,
          changedAt: null,
        },
      });
      expect((await call(url, '/v1/backups')).status).toBe(503);

      const set = await call(url, '/v1/backups/settings', 'PUT', {
        enabled: true,
        everyMs: 6 * 3_600_000,
        keep: 2,
        bucket: null,
      });
      expect(set).toMatchObject({
        status: 200,
        body: { source: 'api', enabled: true, everyMs: 6 * 3_600_000, keep: 2, bucket: null },
      });
      const listed = await call(url, '/v1/backups');
      expect(listed).toMatchObject({ status: 200, body: { everyMs: 6 * 3_600_000, keep: 2 } });
      expect((await call(url, '/v1/backups', 'POST')).status).toBe(201);

      const audit = await call(url, '/v1/audit-events?action=backup.configured');
      expect(audit.body['items']).toMatchObject([
        { action: 'backup.configured', detail: { enabled: true, keep: 2 } },
      ]);
    } finally {
      await first.close();
    }

    // Set through the API, they win over the environment's after a restart too.
    const again = await serve(data, OFF);
    try {
      const listed = await call(again.server.url, '/v1/backups');
      expect(listed).toMatchObject({ status: 200, body: { keep: 2 } });
      expect(listed.body['items']).toHaveLength(1);

      // And turned off, they are none again.
      const off = await call(again.server.url, '/v1/backups/settings', 'PUT', {
        enabled: false,
        everyMs: DAY,
        keep: 3,
        bucket: null,
      });
      expect(off).toMatchObject({ status: 200, body: { source: 'api', enabled: false } });
      expect((await call(again.server.url, '/v1/backups')).status).toBe(503);
    } finally {
      await again.close();
    }
  }, 60_000);

  it('copy to a bucket reached with its own key, checked first, its secret sealed and never said', async () => {
    const data = folder();
    const server = await serve(data, OFF);
    const url = server.server.url;
    const bucket = {
      url: 's3://acme-backups/acentric',
      endpoint: s3.url,
      region: 'us-east-1',
      accessKeyId: 'AKIATEST',
    };
    try {
      const set = await call(url, '/v1/backups/settings', 'PUT', {
        enabled: true,
        everyMs: DAY,
        keep: 3,
        bucket: { ...bucket, secretAccessKey: BUCKET_SECRET },
      });
      expect(set).toMatchObject({ status: 200, body: { bucket } });
      expect(JSON.stringify(set.body)).not.toContain(BUCKET_SECRET);
      // What was written to check it is gone.
      expect([...s3.objects.keys()].filter((name) => name.includes('.acentric-check'))).toEqual([]);

      const taken = await call(url, '/v1/backups', 'POST');
      expect(taken).toMatchObject({ status: 201, body: { inBucket: true } });
      expect(s3.objects.has(`acme-backups/acentric/${String(taken.body['name'])}`)).toBe(true);
      expect(JSON.stringify((await call(url, '/v1/backups/settings')).body)).not.toContain(
        BUCKET_SECRET,
      );

      // The same key, without its secret: the one set before is kept.
      const kept = await call(url, '/v1/backups/settings', 'PUT', {
        enabled: true,
        everyMs: DAY,
        keep: 4,
        bucket,
      });
      expect(kept).toMatchObject({ status: 200, body: { keep: 4, bucket } });
      // Another key needs its secret.
      const another = await call(url, '/v1/backups/settings', 'PUT', {
        enabled: true,
        everyMs: DAY,
        keep: 4,
        bucket: { ...bucket, accessKeyId: 'AKIAOTHER' },
      });
      expect(another.status).toBe(400);

      // A bucket that is not reached is refused, and what was set stays.
      s3.failing = true;
      try {
        const refused = await call(url, '/v1/backups/settings', 'PUT', {
          enabled: true,
          everyMs: DAY,
          keep: 5,
          bucket: { ...bucket, secretAccessKey: BUCKET_SECRET },
        });
        expect(refused.status).toBe(409);
        expect(JSON.stringify(refused.body)).toContain('The bucket is not reached');
      } finally {
        s3.failing = false;
      }
      expect((await call(url, '/v1/backups/settings')).body).toMatchObject({ keep: 4 });
    } finally {
      await server.close();
    }

    // Kept sealed in the database.
    const db = new DatabaseSync(join(data, 'engine.sqlite'), { readOnly: true });
    try {
      const row = db.prepare('SELECT bucket_secret AS secret FROM backup_settings').get() as {
        secret: string;
      };
      expect(row.secret).not.toContain(BUCKET_SECRET);
      expect(row.secret.startsWith('v1.')).toBe(true);
    } finally {
      db.close();
    }
  }, 60_000);

  it('are those the backup before a new version changes the database is taken with', async () => {
    const data = folder();
    const server = await serve(data, OFF);
    try {
      const set = await call(server.server.url, '/v1/backups/settings', 'PUT', {
        enabled: true,
        everyMs: DAY,
        keep: 3,
        bucket: null,
      });
      expect(set.status).toBe(200);
    } finally {
      await server.close();
    }
    const settings = readSettings(env(data, OFF));
    expect(await backUpBeforeUpgrade(settings, '0.16.0', SCHEMA_VERSION + 1)).toBe(true);
    const [taken] = await listBackups(join(data, 'backups'));
    expect(taken).toMatchObject({ kind: 'before-upgrade', version: '0.16.0' });
  }, 60_000);
});
