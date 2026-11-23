// A server filled as people fill one, through its API, and a backup of it: what each release
// leaves here, for every later version to open (releases.test.ts). It is made at a release, from
// that release's code, and never again:
//
//   git checkout v0.16.0 && pnpm build
//   node apps/server/test/releases/seed.ts       # writes <version>.tar.gz and <version>.json here
//
// The model is a stand-in, so no provider is called. The keys are this file's own, for tests.

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { PassThrough } from 'node:stream';
import { createGzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { Providers } from '@acentric/ai';
import type { ModelRunner } from '@acentric/ai';
import { calls, fakeProvider, says } from '@acentric/ai/testing';
import { createClient } from '@acentric/client';
import type { Client } from '@acentric/client';
import type { ActorId } from '@acentric/protocol';
import { SCHEMA_VERSION } from '@acentric/store';

import { bundle } from '../../../../packages/executor/test/bundle.ts';
import { makeBackup } from '../../src/backups/archive.ts';
import { readSettings, start } from '../../src/index.ts';

/** The keys the seeded server is run with: for tests, and nothing else. */
export const SECRET_KEY = '5eed'.repeat(16);
export const ADMIN_KEY = 'the-admin-key-of-the-release-fixtures';
export const MODEL_KEY = 'a-key-the-fake-provider-takes';
export const OWNER = { email: 'owner@example.test', password: 'a-password-of-the-fixtures' };
export const ORDERS_SECRET = 'orders-api-key-sealed-at-the-release';

/** What a seeded server has, for a later version to find. */
export type Facts = {
  readonly version: string;
  readonly schema: number;
  readonly keys: readonly { readonly label: string; readonly token: string }[];
  readonly agents: readonly {
    readonly id: string;
    readonly name: string;
    readonly deployments: number;
  }[];
  readonly actors: readonly {
    readonly id: string;
    readonly agent: string;
    readonly messages: number;
    readonly lastText: string;
    readonly archived: boolean;
  }[];
  readonly blobs: readonly { readonly actor: string; readonly sha256: string }[];
  readonly accounts: readonly string[];
  readonly machines: readonly string[];
  readonly invites: number;
  readonly audit: number;
};

/**
 * The stand-in model: it calls the tool the agent has, once, and then says what the tool
 * said. The same for the seeded server and the one that opens it.
 */
export const model: ModelRunner = {
  async run(step) {
    // What came of this turn's tool call: after the message that began it.
    const asked = step.messages.findLastIndex((message) => message.role === 'user');
    const result = step.messages
      .slice(asked + 1)
      .findLast((message) => message.role === 'tool_result');
    if (result !== undefined) {
      const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
      return says(`The tool said: ${text}`);
    }
    if (step.tools.some((tool) => tool.name === 'lookup_order')) {
      return calls({ id: 'call-1', name: 'lookup_order', arguments: { id: 42 } });
    }
    return calls({ id: 'call-1', name: 'take_picture', arguments: {} });
  },
};

export const providers = () => new Providers([fakeProvider(model, { keys: [MODEL_KEY] })]);

/** Sends an actor a message, and waits until its turn has ended. */
export async function turn(client: Client, actor: ActorId, payload: object): Promise<void> {
  const before = (await client.call('actors.get', { params: { actor } })).lastTurn?.at ?? 0;
  await client.call('inputs.send', { params: { actor }, body: { type: 'message', payload } });
  for (let waited = 0; waited < 30_000; waited += 50) {
    const now = await client.call('actors.get', { params: { actor } });
    if (now.status === 'idle' && (now.lastTurn?.at ?? 0) > before) {
      if (now.lastTurn?.end !== 'ok')
        throw new Error(`the turn ended ${String(now.lastTurn?.end)}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`the turn of ${actor} did not end`);
}

/** The text an actor last said. */
export async function lastText(client: Client, actor: ActorId): Promise<string> {
  const { items } = await client.call('messages.list', {
    params: { actor },
    query: { limit: 200 },
  });
  const last = items.at(-1)?.message as { content?: { type: string; text?: string }[] } | undefined;
  return (last?.content ?? []).map((part) => part.text ?? '').join('');
}

/** Fills a server on `data` as people would, and says what it has. */
export async function seed(data: string, version: string): Promise<Facts> {
  const server = await start(
    readSettings({
      ACENTRIC_PORT: '0',
      ACENTRIC_DATA: data,
      ACENTRIC_SECRET_KEY: SECRET_KEY,
      ACENTRIC_CODE_PROCESSES: '1',
      ACENTRIC_BACKUP_EVERY: 'off',
    }),
    { version, providers: providers(), log: () => {} },
  );
  try {
    const token = new URL(server.setupLink as string).searchParams.get('token') as string;
    const signedOut = createClient({ baseUrl: server.server.url });
    const owner = await signedOut.call('setup.complete', {
      body: { token, ...OWNER, displayName: 'The Owner', client: 'cli' },
    });
    const client = createClient({
      baseUrl: server.server.url,
      token: (owner as { token: string }).token,
    });

    const made = await client.call('keys.create', {
      body: { label: 'for CI', scope: { type: 'engine' }, permissions: ['agents:deploy'] },
    });
    await client.call('invites.create', { body: { role: 'member', note: 'a teammate' } });
    await client.call('accounts.create', {
      body: { provider: 'fake', name: 'main', apiKey: MODEL_KEY },
    });

    const deploy = async (name: string, fixture: string) =>
      client.call('deployments.create', {
        body: { agent: name, manifest: { protocol: 1, sdk: version }, code: await bundle(fixture) },
      });
    const { agent: orders } = await deploy('orders', 'orders');
    const { agent: camera } = await deploy('camera', 'camera');
    await client.call('secrets.set', {
      params: { agent: orders.id, name: 'ORDERS_API_KEY' },
      body: { value: ORDERS_SECRET },
    });

    const actorOf = async (agent: string, name: string, configuration?: object) =>
      (
        await client.call('actors.create', {
          params: { agent: agent as never },
          body: { name, ...(configuration === undefined ? {} : { configuration }) },
        })
      ).actor;
    const asking = await actorOf(orders.id, 'asking', { region: 'us' });
    await turn(client, asking.id, { text: 'What happened to order 42?' });
    const looking = await actorOf(camera.id, 'looking');
    await turn(client, looking.id, { text: 'What is this?', picture: 3 });
    const done = await actorOf(orders.id, 'done', {});
    await turn(client, done.id, { text: 'And order 42?' });
    await client.call('actors.archive', { params: { actor: done.id } });

    await client.call('machines.create', { body: { name: 'build-box', agents: '*' } });

    const actors = [];
    for (const [actor, agent, archived] of [
      [asking, orders, false],
      [looking, camera, false],
      [done, orders, true],
    ] as const) {
      const { items } = await client.call('messages.list', {
        params: { actor: actor.id },
        query: { limit: 200 },
      });
      actors.push({
        id: actor.id,
        agent: agent.id,
        messages: items.length,
        lastText: await lastText(client, actor.id),
        archived,
      });
    }
    // The pictures the camera's conversation has: the one it was sent, and the one it took.
    const picture = (fill: number) =>
      createHash('sha256').update(new Uint8Array(2000).fill(fill)).digest('hex');
    const audit = await client.call('audit.list', { query: { limit: 100 } });
    const deployments = async (agent: typeof orders) =>
      (await client.call('deployments.list', { params: { agent: agent.id } })).items.length;
    return {
      version,
      schema: SCHEMA_VERSION,
      keys: [{ label: 'for CI', token: made.token }],
      agents: [
        { id: orders.id, name: 'orders', deployments: await deployments(orders) },
        { id: camera.id, name: 'camera', deployments: await deployments(camera) },
      ],
      actors,
      blobs: [
        { actor: looking.id, sha256: picture(3) },
        { actor: looking.id, sha256: picture(7) },
      ],
      accounts: ['main'],
      machines: ['build-box'],
      invites: 1,
      audit: audit.items.length,
    };
  } finally {
    await server.close();
  }
}

/** Seeds a server, and writes its backup and what it has beside this file, by its version. */
async function main(): Promise<void> {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const { version } = JSON.parse(
    await readFile(join(here, '..', '..', 'package.json'), 'utf8'),
  ) as { version: string };
  const data = await mkdtemp(join(tmpdir(), 'acentric-release-seed-'));
  try {
    const facts = await seed(data, version);
    // Gzipped: most of it is the database's empty pages.
    const tar = new PassThrough();
    const written = pipeline(
      tar,
      createGzip({ level: 9 }),
      createWriteStream(join(here, `${version}.tar.gz`)),
    );
    await makeBackup({ data, out: tar, version, kind: 'manual' });
    tar.end();
    await written;
    await writeFile(join(here, `${version}.json`), `${JSON.stringify(facts, null, 2)}\n`);
    console.log(
      `seeded ${version} (schema ${String(facts.schema)}): ${version}.tar.gz, ${version}.json`,
    );
  } finally {
    await rm(data, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
