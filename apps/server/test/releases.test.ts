// What each release left (test/releases: a backup of a server filled as people fill one, made
// by that release), opened by this version: the database moved on to this version's schema, and
// everything there as it was. People sign in, keys work, the conversations and their pictures
// are there, and an agent deployed by that release still runs here, with its sealed secret.

import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';
import { createHash } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { createClient } from '@acentric/client';
import type { ActorId, AgentId } from '@acentric/protocol';
import { SCHEMA_VERSION } from '@acentric/store';

import { restore } from '../src/backups/archive.ts';
import { readSettings, start } from '../src/index.ts';
import { ADMIN_KEY, ORDERS_SECRET, OWNER, SECRET_KEY, providers, turn } from './releases/seed.ts';
import type { Facts } from './releases/seed.ts';

const HERE = join(import.meta.dirname, 'releases');
const releases = (await readdir(HERE))
  .filter((name) => name.endsWith('.json'))
  .map((name) => name.slice(0, -'.json'.length))
  .toSorted();

const folders: string[] = [];
afterAll(async () => {
  for (const made of folders.splice(0)) await rm(made, { recursive: true, force: true });
});

describe('what a release left', () => {
  it('is there for each release', () => {
    expect(releases).toContain('0.15.0');
  });

  for (const release of releases) {
    it(`opens here as ${release} left it`, async () => {
      const facts = JSON.parse(await readFile(join(HERE, `${release}.json`), 'utf8')) as Facts;
      expect(facts.schema).toBeLessThanOrEqual(SCHEMA_VERSION);
      const data = await mkdtemp(join(tmpdir(), `acentric-release-${release}-`));
      folders.push(data);
      const settings = readSettings({
        ACENTRIC_PORT: '0',
        ACENTRIC_DATA: data,
        ACENTRIC_SECRET_KEY: SECRET_KEY,
        ACENTRIC_ADMIN_KEY: ADMIN_KEY,
        ACENTRIC_CODE_PROCESSES: '1',
      });
      await restore({
        data,
        input: createReadStream(join(HERE, `${release}.tar.gz`)).pipe(createGunzip()),
        keys: Object.keys(settings.secretKeys?.keys ?? {}),
      });

      const server = await start(settings, {
        version: 'this',
        providers: providers(),
        log: () => {},
      });
      try {
        const admin = createClient({ baseUrl: server.server.url, token: ADMIN_KEY });

        // The owner signs in with their password; the key made then still works.
        const signedOut = createClient({ baseUrl: server.server.url });
        const signedIn = await signedOut.call('auth.signIn', {
          body: { ...OWNER, client: 'cli' },
        });
        expect(signedIn).toMatchObject({ user: { email: OWNER.email, role: 'owner' } });
        for (const key of facts.keys) {
          const keyed = createClient({ baseUrl: server.server.url, token: key.token });
          await expect(keyed.call('me.get', {})).resolves.toBeTruthy();
        }

        // The agents and each of their deployments.
        for (const agent of facts.agents) {
          const found = await admin.call('agents.get', { params: { agent: agent.id as AgentId } });
          expect(found.name).toBe(agent.name);
          const deployments = await admin.call('deployments.list', {
            params: { agent: agent.id as AgentId },
          });
          expect(deployments.items).toHaveLength(agent.deployments);
        }

        // The conversations, as they were, and their pictures.
        for (const actor of facts.actors) {
          const found = await admin.call('actors.get', { params: { actor: actor.id as ActorId } });
          expect(found.archivedAt !== null).toBe(actor.archived);
          const { items } = await admin.call('messages.list', {
            params: { actor: actor.id as ActorId },
            query: { limit: 200 },
          });
          expect(items).toHaveLength(actor.messages);
          const last = items.at(-1)?.message as { content: { text?: string }[] };
          expect(last.content.map((part) => part.text ?? '').join('')).toBe(actor.lastText);
        }
        for (const blob of facts.blobs) {
          const { bytes } = await admin.blob(blob.actor as ActorId, blob.sha256);
          expect(createHash('sha256').update(bytes).digest('hex')).toBe(blob.sha256);
        }

        // The model accounts, the machines, the invites and the audit log.
        const accounts = await admin.call('accounts.list', {});
        expect(accounts.items.map((account) => account.name)).toEqual(facts.accounts);
        // Each actor the release left is given what its calls were made with then: the
        // release's one account, its provider's default.
        for (const actor of facts.actors) {
          const found = await admin.call('actors.get', { params: { actor: actor.id as ActorId } });
          expect(found.account).toBe(accounts.items[0]?.id);
        }
        const machines = await admin.call('machines.list', {});
        expect(machines.items.map((machine) => machine.name)).toEqual(facts.machines);
        const invites = await admin.call('invites.list', {});
        expect(invites.items).toHaveLength(facts.invites);
        const audit = await admin.call('audit.list', { query: { limit: 100 } });
        expect(audit.items.length).toBeGreaterThanOrEqual(facts.audit);

        // The agent that release deployed runs here, and its secret, sealed then, opens.
        const asking = facts.actors.find(
          (actor) => !actor.archived && actor.agent === facts.agents[0]?.id,
        );
        if (asking === undefined) throw new Error('the release left no actor of orders');
        await turn(admin, asking.id as ActorId, { text: 'What happened to order 42, again?' });
        const { items } = await admin.call('messages.list', {
          params: { actor: asking.id as ActorId },
          query: { limit: 200 },
        });
        expect(items).toHaveLength(asking.messages + 4);
        expect(JSON.stringify(items.at(-1))).toContain(`asked with ${ORDERS_SECRET}`);
      } finally {
        await server.close();
      }
    }, 120_000);
  }
});
