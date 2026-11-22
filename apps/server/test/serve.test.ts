// The whole server, as it runs: its program's own start-up on a real port, a database on disk,
// and an agent's real code in workerd. Only the model is a stand-in. It is called through the
// client, over the network.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Providers } from '@acentric/ai';
import type { ModelRunner } from '@acentric/ai';
import { calls, fakeProvider, says } from '@acentric/ai/testing';
import { createClient } from '@acentric/client';
import type { Client } from '@acentric/client';
import type { ActorEvent, ActorId } from '@acentric/protocol';

import { bundle } from '../../../packages/executor/test/bundle.ts';
import { readSettings, start } from '../src/index.ts';

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
      providers: new Providers([fakeProvider(model)]),
      runner: model,
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
    const { actor } = await client.call('actors.create', {
      params: { agent: deployed.agent.id },
      body: { configuration: { region: 'eu' }, externalId: 'telegram:4411' },
    });

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
});
