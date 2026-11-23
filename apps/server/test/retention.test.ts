// What the server removes as it goes: what expired, always; archived actors, the audit log and
// usage, past how long its settings keep each; and nothing of what it is told to keep for ever.

import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';

import { afterAll, describe, expect, it } from 'vitest';

import { createClient } from '@acentric/client';
import type { ActorId } from '@acentric/protocol';

import { restore } from '../src/backups/archive.ts';
import { readSettings, start } from '../src/index.ts';
import { ADMIN_KEY, SECRET_KEY, providers } from './releases/seed.ts';
import type { Facts } from './releases/seed.ts';

const RELEASE = join(import.meta.dirname, 'releases', '0.15.0');
/** Past the 90 days the owner's session lasts, and the 7 its invite does. */
const LATER = 100 * 86_400_000;
const folders: string[] = [];
afterAll(async () => {
  for (const made of folders.splice(0)) await rm(made, { recursive: true, force: true });
});

/** A server on what the 0.15.0 release left, 100 days on, with `env` for its settings. */
async function later(env: Record<string, string>) {
  const data = await mkdtemp(join(tmpdir(), 'acentric-retention-'));
  folders.push(data);
  const settings = readSettings({
    ACENTRIC_PORT: '0',
    ACENTRIC_DATA: data,
    ACENTRIC_SECRET_KEY: SECRET_KEY,
    ACENTRIC_ADMIN_KEY: ADMIN_KEY,
    ACENTRIC_CODE_PROCESSES: '1',
    ACENTRIC_BACKUP_EVERY: 'off',
    ...env,
  });
  await restore({
    data,
    input: createReadStream(`${RELEASE}.tar.gz`).pipe(createGunzip()),
    keys: Object.keys(settings.secretKeys?.keys ?? {}),
  });
  const facts = (
    (await import(`${RELEASE}.json`, { with: { type: 'json' } })) as { default: Facts }
  ).default;
  const server = await start(settings, {
    version: 'this',
    providers: providers(),
    log: () => {},
    clock: () => Date.now() + LATER,
  });
  return { server, facts, admin: createClient({ baseUrl: server.server.url, token: ADMIN_KEY }) };
}

describe('old data', () => {
  it('is removed past how long it is kept: archived actors, the audit log, usage', async () => {
    const { server, facts, admin } = await later({
      ACENTRIC_RETAIN_ARCHIVED: '7d',
      ACENTRIC_RETAIN_AUDIT: '7d',
      ACENTRIC_RETAIN_USAGE: '7d',
    });
    try {
      const archived = facts.actors.filter((actor) => actor.archived);
      const kept = facts.actors.filter((actor) => !actor.archived);
      expect(archived).toHaveLength(1);

      const removed = await server.retention.run();
      expect(removed).toMatchObject({ actors: 1 });
      expect(removed.auditEvents).toBeGreaterThanOrEqual(facts.audit);
      expect(removed.usage).toBeGreaterThan(0);
      // The owner's session and the invite, made when the release was, have expired.
      expect(removed.sessions).toBeGreaterThan(0);
      expect(removed.links).toBe(facts.invites);

      for (const actor of archived) {
        await expect(
          admin.call('actors.get', { params: { actor: actor.id as ActorId } }),
        ).rejects.toMatchObject({ status: 404 });
      }
      // Actors that are not archived are kept, whatever their age, and their pictures.
      for (const actor of kept) {
        await expect(
          admin.call('actors.get', { params: { actor: actor.id as ActorId } }),
        ).resolves.toMatchObject({ id: actor.id });
      }
      for (const blob of facts.blobs) {
        const { bytes } = await admin.blob(blob.actor as ActorId, blob.sha256);
        expect(bytes.length).toBe(2000);
      }
      // What it removed is written down, in what is left of the audit log.
      const { items } = await admin.call('audit.list', { query: { limit: 100 } });
      expect(items.map((event) => event.action)).toEqual(['retention.removed']);
      expect(items[0]?.detail).toMatchObject({ actors: 1, auditEvents: removed.auditEvents });

      // Run again, it has nothing more to remove, and says nothing of it.
      expect(await server.retention.run()).toMatchObject({
        actors: 0,
        auditEvents: 0,
        usage: 0,
      });
      expect((await admin.call('audit.list', { query: { limit: 100 } })).items).toHaveLength(1);
    } finally {
      await server.close();
    }
  }, 120_000);

  it('is kept for ever without the settings, but for what expired', async () => {
    const { server, facts, admin } = await later({});
    try {
      const removed = await server.retention.run();
      expect(removed).toMatchObject({ actors: 0, auditEvents: 0, usage: 0 });
      expect(removed.sessions).toBeGreaterThan(0);
      for (const actor of facts.actors) {
        await expect(
          admin.call('actors.get', { params: { actor: actor.id as ActorId } }),
        ).resolves.toMatchObject({ id: actor.id });
      }
      const audit = await admin.call('audit.list', { query: { limit: 100 } });
      expect(audit.items.length).toBeGreaterThanOrEqual(facts.audit);
      expect(audit.items.map((event) => event.action)).not.toContain('retention.removed');
    } finally {
      await server.close();
    }
  }, 120_000);
});
