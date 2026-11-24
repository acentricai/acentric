// Changing the key secrets are sealed with: the new one given as the current and the old one
// kept; the server says what is still sealed with the old; `reseal` seals it all again with the
// new; then the old says it seals nothing, and goes, and everything opens without it.

import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createGunzip } from 'node:zlib';

import { afterAll, describe, expect, it } from 'vitest';

import { openWith, sealWith, sealedFor } from '@acentric/core';
import type { SecretKeys } from '@acentric/core';
import { createClient } from '@acentric/client';
import type { ActorId } from '@acentric/protocol';
import { SqliteStore } from '@acentric/store';

import { restore } from '../src/backups/archive.ts';
import { DataInUse } from '../src/backups/lock.ts';
import { readSettings, start } from '../src/index.ts';
import { sealedKeys } from '../src/sealed.ts';
import { keysSaid, resealData } from '../src/start.ts';
import { ADMIN_KEY, ORDERS_SECRET, SECRET_KEY, providers, turn } from './releases/seed.ts';
import type { Facts } from './releases/seed.ts';

const RELEASE = join(import.meta.dirname, 'releases', '0.15.0');
const NEW_KEY = 'fe'.repeat(32);

const folders: string[] = [];
afterAll(async () => {
  for (const made of folders.splice(0)) await rm(made, { recursive: true, force: true });
});

const settingsOf = (data: string, env: Record<string, string>) =>
  readSettings({
    ACENTRIC_PORT: '0',
    ACENTRIC_DATA: data,
    ACENTRIC_ADMIN_KEY: ADMIN_KEY,
    ACENTRIC_CODE_PROCESSES: '1',
    ...env,
  });
const keysOf = (settings: ReturnType<typeof readSettings>): SecretKeys => {
  if (settings.secretKeys === undefined) throw new Error('no keys');
  return settings.secretKeys;
};

describe('a changed key for secrets', () => {
  it('is what everything is sealed with, once it is sealed again, and the old one goes', async () => {
    const data = await mkdtemp(join(tmpdir(), 'acentric-reseal-'));
    folders.push(data);
    const before = settingsOf(data, { ACENTRIC_SECRET_KEY: SECRET_KEY });
    await restore({
      data,
      input: createReadStream(`${RELEASE}.tar.gz`).pipe(createGunzip()),
      keys: Object.keys(keysOf(before).keys),
    });
    const facts = (await import(`${RELEASE}.json`, { with: { type: 'json' } })) as {
      default: Facts;
    };
    const actor = facts.default.actors[0]?.id as ActorId;
    // Brought up to this version's database, as a server of it would, before it is sealed again.
    await (await SqliteStore.open(join(data, 'engine.sqlite'))).close();

    // An actor's variables and a sandbox provider's key, sealed with the old key, beside the
    // secret and the model account's key the release left.
    const old = keysOf(before);
    const path = join(data, 'engine.sqlite');
    const db = new DatabaseSync(path);
    db.prepare('UPDATE actors SET machine_env = ? WHERE id = ?').run(
      sealWith(old, sealedFor.actorEnv(actor), '{"REGION":"eu"}'),
      actor,
    );
    db.prepare(
      'INSERT INTO sandbox_providers (id, name, kind, credential, account, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      'sbp_test',
      'boat',
      'boat',
      sealWith(old, sealedFor.provider('sbp_test'), 'boat-key'),
      null,
      1,
    );
    // And the secret of the bucket backups are copied to, as set through the API.
    db.prepare(
      `INSERT INTO backup_settings (id, enabled, every_ms, keep, bucket_url, bucket_key_id,
         bucket_secret, changed_at) VALUES (1, 1, 86400000, 3, 's3://b/acentric', 'AKIA', ?, 1)`,
    ).run(sealWith(old, sealedFor.backupBucket(), 'bucket-secret'));
    db.close();

    // Only the new key: what the old one sealed does not open, and the server says so.
    const without = settingsOf(data, { ACENTRIC_SECRET_KEY: NEW_KEY });
    expect(keysSaid(without)).toEqual([
      `5 sealed values are sealed with the key ${old.current}, which this server was not given: they do not open. Give it in ACENTRIC_SECRET_KEYS_OLD.`,
    ]);
    expect(() => resealData(without)).toThrow(`which this engine was not given`);

    // The new key, and the old one beside it.
    const changed = settingsOf(data, {
      ACENTRIC_SECRET_KEY: NEW_KEY,
      ACENTRIC_SECRET_KEYS_OLD: SECRET_KEY,
    });
    const keys = keysOf(changed);
    expect(keysSaid(changed)).toEqual([
      expect.stringContaining(
        `5 sealed values are sealed with the old key ${old.current}: \`acentric-server reseal\``,
      ),
    ]);

    // Not while a server runs on the data.
    const running = await start(changed, {
      version: 'this',
      providers: providers(),
      log: () => {},
    });
    try {
      expect(() => resealData(changed)).toThrow(DataInUse);
    } finally {
      await running.close();
    }

    expect(resealData(changed)).toBe(5);
    expect(resealData(changed)).toBe(0);
    expect(keysSaid(changed)).toEqual([
      `ACENTRIC_SECRET_KEYS_OLD has ${old.current}, which nothing is sealed with: it may be taken out.`,
    ]);
    const after = new DatabaseSync(path, { readOnly: true });
    try {
      expect([...sealedKeys(after)]).toEqual([[keys.current, 5]]);
      // Each opens with the new key alone, as what it was.
      const only: SecretKeys = {
        current: keys.current,
        keys: { [keys.current]: keys.keys[keys.current] as Uint8Array },
      };
      const env = after
        .prepare('SELECT machine_env AS value FROM actors WHERE id = ?')
        .get(actor) as { value: string };
      expect(openWith(only, sealedFor.actorEnv(actor), env.value, 'env')).toBe('{"REGION":"eu"}');
      const provider = after
        .prepare("SELECT credential AS value FROM sandbox_providers WHERE id = 'sbp_test'")
        .get() as { value: string };
      expect(openWith(only, sealedFor.provider('sbp_test'), provider.value, 'provider')).toBe(
        'boat-key',
      );
      const bucket = after
        .prepare('SELECT bucket_secret AS value FROM backup_settings WHERE id = 1')
        .get() as { value: string };
      expect(openWith(only, sealedFor.backupBucket(), bucket.value, 'bucket')).toBe(
        'bucket-secret',
      );
    } finally {
      after.close();
    }

    // The old key gone: the agent the release deployed reads its secret, sealed again.
    const server = await start(settingsOf(data, { ACENTRIC_SECRET_KEY: NEW_KEY }), {
      version: 'this',
      providers: providers(),
      log: () => {},
    });
    try {
      const admin = createClient({ baseUrl: server.server.url, token: ADMIN_KEY });
      await turn(admin, actor, { text: 'What happened to order 42?' });
      const { items } = await admin.call('messages.list', {
        params: { actor },
        query: { limit: 200 },
      });
      expect(JSON.stringify(items.at(-1))).toContain(`asked with ${ORDERS_SECRET}`);
    } finally {
      await server.close();
    }
  }, 120_000);

  it('is refused when the key for secrets is not given at all', () => {
    expect(() => resealData(readSettings({ ACENTRIC_DATA: tmpdir() }))).toThrow(
      'ACENTRIC_SECRET_KEY is what values are sealed with again, and is not given',
    );
  });
});
