// The whole server, as it runs: its program's own start-up on a real port, a database on disk,
// and an agent's real code in workerd. Only the model is a stand-in. It is called through the
// client, over the network.

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Providers } from '@acentric/ai';
import type { ModelRunner, ModelStep } from '@acentric/ai';
import { calls, fakeProvider, says } from '@acentric/ai/testing';
import { createClient } from '@acentric/client';
import type { Client } from '@acentric/client';
import type { ActorEvent, ActorId } from '@acentric/protocol';

import { bundle } from '../../../packages/executor/test/bundle.ts';
import { readSettings, resetLink, start } from '../src/index.ts';

/** A model that looks an order up when it is asked something, and says what it found. */
const model: ModelRunner = {
  async run(step) {
    const last = step.messages.at(-1);
    if (last?.role === 'tool_result') {
      return says(last.content.map((part) => (part.type === 'text' ? part.text : '')).join(''));
    }
    const asked = step.messages.filter((message) => message.role === 'user').length;
    return calls({ id: `call-${String(asked)}`, name: 'lookup_order', arguments: { id: 4411 } });
  },
};

const MODEL_KEY = 'a-key-the-fake-provider-takes';

let dir: string;
let code: string;
const up = () =>
  start(
    readSettings({
      ACENTRIC_PORT: '0',
      ACENTRIC_DATA: dir,
      ACENTRIC_SECRET_KEY: 'ab'.repeat(32),
      ACENTRIC_CODE_PROCESSES: '1',
    }),
    {
      version: 'test',
      // No runner in place of the model accounts: the model is called with one, as it is by
      // a server that calls real providers.
      providers: new Providers([fakeProvider(model, { keys: [MODEL_KEY] })]),
      log: () => {},
      checkAnswers: true,
    },
  );

/** Sends an actor a message, and gives every event until it is idle again. */
async function turn(client: Client, actor: ActorId, text: string): Promise<ActorEvent[]> {
  const stop = new AbortController();
  const seen: ActorEvent[] = [];
  const following = (async () => {
    for await (const event of client.events(actor, { signal: stop.signal })) {
      seen.push(event);
      const worked = seen.some((one) => one.type === 'status' && one.status === 'working');
      if (worked && event.type === 'status' && event.status === 'idle') stop.abort();
    }
  })();
  // Followed from before the message is sent, so that nothing of the turn is missed.
  await expect.poll(() => seen.length).toBeGreaterThan(0);
  await client.call('inputs.send', {
    params: { actor },
    body: { type: 'message', payload: { text } },
  });
  await following;
  return seen;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'acentric-server-'));
  code = await bundle('orders');
}, 30_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('a server', () => {
  it('is deployed to and talked to, is stopped, and goes on where it was when it starts again', async () => {
    const first = await up();
    // It had no way in, so it made one, to be shown once.
    expect(first.firstKey).toMatch(/^ak_/);
    const token = first.firstKey as string;
    let client = createClient({ baseUrl: first.server.url, token });
    expect(await (await fetch(`${first.server.url}/health`)).json()).toEqual({
      ok: true,
      version: 'test',
    });

    const deployed = await client.call('deployments.create', {
      body: { agent: 'support', manifest: { protocol: 1, sdk: '0.15.0' }, code },
    });
    expect(deployed).toMatchObject({ created: true, missingSecrets: ['ORDERS_API_KEY'] });
    await client.call('secrets.set', {
      params: { agent: deployed.agent.id, name: 'ORDERS_API_KEY' },
      body: { value: 'k-1' },
    });
    // What its model is called with: no setting of the server's says. An actor is given it.
    const account = await client.call('accounts.create', {
      body: { provider: 'fake', name: 'main', apiKey: MODEL_KEY },
    });
    const { actor } = await client.call('actors.create', {
      params: { agent: deployed.agent.id },
      body: { configuration: { region: 'eu' }, externalId: 'telegram:4411' },
    });
    expect(actor.account).toBe(account.id);

    const events = await turn(client, actor.id, 'Why two refunds?');
    const roles = events.flatMap((event) =>
      event.type === 'message' ? [event.entry.message.role] : [],
    );
    expect(roles).toEqual(['user', 'assistant', 'tool_result', 'assistant']);
    const conversation = await client.call('messages.list', { params: { actor: actor.id } });
    // The agent's own code ran, in workerd, and read its secret.
    expect(conversation.items[2]?.message).toMatchObject({
      role: 'tool_result',
      content: [
        { type: 'text', text: 'Order 4411 was refunded twice, one second apart. (asked with k-1)' },
      ],
    });
    await first.close();
    await expect(client.call('me.get')).rejects.toThrow(/fetch failed/);

    // Started again on the same data: nothing was lost, and it needs no new key.
    const second = await up();
    expect(second.firstKey).toBeUndefined();
    client = createClient({ baseUrl: second.server.url, token });
    expect(
      (await client.call('actors.list', { query: { externalId: 'telegram:4411' } })).items,
    ).toMatchObject([{ id: actor.id, lastTurn: { end: 'ok' } }]);
    expect(
      (await client.call('messages.list', { params: { actor: actor.id } })).items,
    ).toHaveLength(4);

    // The code is loaded again from the database, into processes that have never seen it.
    await turn(client, actor.id, 'And was it a mistake?');
    const after = await client.call('messages.list', {
      params: { actor: actor.id },
      query: { order: 'desc', limit: 2 },
    });
    expect(after.items.map((entry) => [entry.seq, entry.message.role])).toEqual([
      [8, 'assistant'],
      [7, 'tool_result'],
    ]);
    // The account was kept, sealed, and its key opened again: both turns' calls are its.
    const usage = await client.call('usage.get', { query: { by: 'account' } });
    expect(usage.groups?.map((group) => [group.key, group.totals.calls])).toEqual([
      [account.id, 4],
    ]);
    expect((await client.call('usage.actor', { params: { actor: actor.id } })).totals.calls).toBe(
      4,
    );
    await second.close();
  }, 60_000);

  it('keeps images as files beside its database, and they go when their agent does', async () => {
    const data = join(dir, 'pictures');
    const sent: ModelStep[] = [];
    /** A model that takes a picture when it is first asked, and then says what it has. */
    const looking: ModelRunner = {
      async run(step) {
        sent.push(structuredClone(step));
        const taken = step.messages.some((message) => message.role === 'tool_result');
        return taken
          ? says('Two pictures.')
          : calls({ id: 'call-1', name: 'take_picture', arguments: {} });
      },
    };
    const begin = () =>
      start(
        readSettings({ ACENTRIC_PORT: '0', ACENTRIC_DATA: data, ACENTRIC_CODE_PROCESSES: '1' }),
        {
          version: 'test',
          providers: new Providers([fakeProvider(looking)]),
          runner: looking,
          log: () => {},
          checkAnswers: true,
        },
      );
    /** The blobs there are on the disk, by name. */
    const onDisk = async () =>
      (await readdir(join(data, 'blobs'), { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .toSorted();
    const pictureOf = (fill: number) => {
      const bytes = new Uint8Array(2000).fill(fill);
      return {
        bytes,
        base64: Buffer.from(bytes).toString('base64'),
        digest: createHash('sha256').update(bytes).digest('hex'),
      };
    };
    const shown = pictureOf(3);
    const taken = pictureOf(7);

    const first = await begin();
    const token = first.firstKey as string;
    let client = createClient({ baseUrl: first.server.url, token });
    const { agent } = await client.call('deployments.create', {
      body: {
        agent: 'camera',
        manifest: { protocol: 1, sdk: '0.15.0' },
        code: await bundle('camera'),
      },
    });
    const { actor } = await client.call('actors.create', { params: { agent: agent.id }, body: {} });
    await client.call('inputs.send', {
      params: { actor: actor.id },
      body: { type: 'message', payload: { text: 'What is this?', picture: 3 } },
    });
    await expect
      .poll(async () => (await client.call('actors.get', { params: { actor: actor.id } })).lastTurn)
      .toMatchObject({ end: 'ok' });

    // The agent's real code gave the bytes, in workerd. The conversation only names them.
    const { items } = await client.call('messages.list', { params: { actor: actor.id } });
    const blob = (digest: string) => ({
      type: 'image',
      source: { type: 'blob', digest, mediaType: 'image/png', size: 2000 },
    });
    expect(items[0]?.message).toMatchObject({
      content: [{ type: 'text', text: 'What is this?' }, blob(shown.digest)],
    });
    expect(items[2]?.message).toMatchObject({
      role: 'tool_result',
      content: [blob(taken.digest), { type: 'text', text: 'Taken.' }],
    });
    expect(JSON.stringify(items)).not.toContain(shown.base64);
    expect(await onDisk()).toEqual([shown.digest, taken.digest].toSorted());
    expect(await client.blob(actor.id, taken.digest)).toEqual({
      bytes: taken.bytes,
      mediaType: 'image/png',
    });
    await first.close();

    // What a process that died left behind, with no blob of its name anywhere.
    const orphan = join(data, 'blobs', 'ff', 'ff', 'f'.repeat(64));
    await mkdir(join(orphan, '..'), { recursive: true });
    await writeFile(orphan, 'left behind');

    const second = await begin();
    client = createClient({ baseUrl: second.server.url, token });
    expect(await onDisk()).toEqual([shown.digest, taken.digest].toSorted());
    // Read from the disk again: for whoever asks, and for the model.
    expect((await client.blob(actor.id, shown.digest)).bytes).toEqual(shown.bytes);
    sent.length = 0;
    await client.call('inputs.send', {
      params: { actor: actor.id },
      body: { type: 'message', payload: { text: 'And now?' } },
    });
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]?.messages[0]).toMatchObject({
      content: [
        { type: 'text', text: 'What is this?' },
        { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: shown.base64 } },
      ],
    });
    expect(JSON.stringify(sent[0]?.messages[2])).toContain(taken.base64);
    await expect
      .poll(async () => (await client.call('messages.list', { params: { actor: actor.id } })).items)
      .toHaveLength(6);

    await client.call('agents.delete', { params: { agent: agent.id } });
    expect(await onDisk()).toEqual([]);
    await second.close();
  }, 60_000);

  it('picks up, when it starts, a turn the one before it was stopped in the middle of', async () => {
    const waiting: ModelRunner = {
      // The first call of the model never answers: the server is stopped while it waits.
      run: () => new Promise(() => {}),
    };
    const first = await start(
      readSettings({
        ACENTRIC_PORT: '0',
        ACENTRIC_DATA: join(dir, 'owed'),
        ACENTRIC_CODE_PROCESSES: '1',
      }),
      {
        version: 'test',
        providers: new Providers([fakeProvider(waiting)]),
        runner: waiting,
        log: () => {},
      },
    );
    const token = first.firstKey as string;
    let client = createClient({ baseUrl: first.server.url, token });
    const deployed = await client.call('deployments.create', {
      body: { agent: 'support', manifest: { protocol: 1, sdk: '0.15.0' }, code },
    });
    const { actor } = await client.call('actors.create', {
      params: { agent: deployed.agent.id },
      body: { configuration: {} },
    });
    await client.call('inputs.send', {
      params: { actor: actor.id },
      body: { type: 'message', payload: { text: 'Why two refunds?' } },
    });
    await expect
      .poll(async () => (await client.call('actors.get', { params: { actor: actor.id } })).status)
      .toBe('working');
    await first.close({ graceMs: 0 });

    const second = await start(
      readSettings({
        ACENTRIC_PORT: '0',
        ACENTRIC_DATA: join(dir, 'owed'),
        ACENTRIC_CODE_PROCESSES: '1',
      }),
      {
        version: 'test',
        providers: new Providers([fakeProvider(model)]),
        runner: model,
        log: () => {},
      },
    );
    expect(second.recovered).toBe(1);
    client = createClient({ baseUrl: second.server.url, token });
    await expect
      .poll(
        async () => (await client.call('actors.get', { params: { actor: actor.id } })).lastTurn,
        {
          timeout: 10_000,
        },
      )
      .toMatchObject({ end: 'ok' });
    expect(
      (await client.call('messages.list', { params: { actor: actor.id } })).items.map(
        (entry) => entry.message.role,
      ),
    ).toEqual(['user', 'assistant', 'tool_result', 'assistant']);
    await second.close();
  }, 60_000);

  it('prints a link that makes its owner, and a link that lets an owner who is locked out back in', async () => {
    const settings = readSettings({
      ACENTRIC_PORT: '0',
      ACENTRIC_DATA: join(dir, 'people'),
      ACENTRIC_PUBLIC_URL: 'https://engine.example.com/',
      ACENTRIC_CODE_PROCESSES: '1',
    });
    const more = {
      version: 'test',
      providers: new Providers([fakeProvider(model)]),
      runner: model,
      log: () => {},
      checkAnswers: true,
      passwordCost: 1024,
    };
    const first = await start(settings, more);
    // Where people reach the server, not where it listens.
    expect(first.setupLink).toMatch(/^https:\/\/engine\.example\.com\/setup\?token=al_/);
    const token = new URL(first.setupLink as string).searchParams.get('token') as string;
    const anyone = createClient({ baseUrl: first.server.url });
    const owner = await anyone.call('setup.complete', {
      body: { token, email: 'ada@example.com', password: 'correct horse battery', client: 'cli' },
    });
    const ada = createClient({ baseUrl: first.server.url, token: owner.token as string });
    expect(await ada.call('me.get')).toMatchObject({ type: 'user', role: 'owner' });
    await first.close();

    // Started again, there is a person: no link is made, and her session is still good.
    const second = await start(settings, more);
    expect(second.setupLink).toBeUndefined();
    const again = createClient({ baseUrl: second.server.url, token: owner.token as string });
    expect((await again.call('me.get')).type).toBe('user');

    // She forgets her password. The link is made on the server itself, while it is up.
    const made = await resetLink(settings, 'ada@example.com');
    expect(made.link).toMatch(/^https:\/\/engine\.example\.com\/reset\?token=al_/);
    const fresh = createClient({ baseUrl: second.server.url });
    await fresh.call('password.reset', {
      body: { token: made.token, password: 'a new one, long enough' },
    });
    await expect(again.call('me.get')).rejects.toMatchObject({ code: 'unauthenticated' });
    const back = await fresh.call('auth.signIn', {
      body: { email: 'ada@example.com', password: 'a new one, long enough', client: 'cli' },
    });
    expect(back.user.role).toBe('owner');
    await expect(resetLink(settings, 'nobody@example.com')).rejects.toMatchObject({
      code: 'not_found',
    });
    await second.close();
  }, 60_000);
});
