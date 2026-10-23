// The protocol end to end, with the runner in its own process: kinds an
// application provides, subscriptions over WebSocket, secrets, errors,
// deploying by path and stopping when stdin closes.

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connectWebSocket, RunnerRequestError } from '@acentric/client';
import type { SessionEvent, RunnerClient } from '@acentric/client';
import { spawnRunner } from '@acentric/client/node';
import type { ProvidedHandler, SpawnedRunner } from '@acentric/client/node';
import type { Json } from '@acentric/types';
import { afterEach, describe, expect, it } from 'vitest';

import { RUNNER_BIN } from './protocol-adapter.js';

// Input `ask` declares an effect and `drop` takes it back; each effect's
// outcome is logged as a `result` entry.
const agent = `
export default {
  kinds: ['work', 'secret', 'ask_user', 'notify'],
  init: () => ({ snapshot: { asks: [] } }),
  step: (state, message) => {
    const { snapshot } = state;
    if (message.type === 'input') {
      if (message.kind === 'ask') return { snapshot: { asks: [...snapshot.asks, message.payload] } };
      if (message.kind === 'drop') return { snapshot: { asks: snapshot.asks.filter((a) => a.key !== message.payload.key) } };
      return { error: 'unknown input ' + message.kind };
    }
    if (message.type === 'effect') {
      return {
        snapshot: { asks: snapshot.asks.filter((a) => a.key !== message.key) },
        append: [{ kind: 'result', body: { key: message.key, outcome: message.outcome } }],
      };
    }
    return { snapshot };
  },
  effects: ({ snapshot }) => snapshot.asks.map((a) => ({ key: a.key, kind: a.kind, args: a.args ?? null })),
  view: ({ snapshot }) => ({ asks: snapshot.asks.length }),
};
`;

const handlers = `
export default {
  work: { mode: 'reissue', run: async (ctx) => {
    console.log('a handler writing to stdout must not break the protocol');
    await new Promise((resolve) => setTimeout(resolve, ctx.args?.ms ?? 0));
    return 'worked';
  } },
  secret: { mode: 'reissue', run: (ctx) => ctx.secrets.get('token') },
};
`;

const bundle = {
  name: 'app',
  version: '1',
  agent,
  handlers,
  provides: { ask_user: { mode: 'reissue' as const }, notify: { mode: 'once' as const } },
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'acentric-proto-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function runner(
  dir: string,
  provides?: Record<string, ProvidedHandler>,
): Promise<SpawnedRunner> {
  const spawned = await spawnRunner({
    store: `sqlite:${join(dir, 'store.db')}`,
    command: process.execPath,
    args: [RUNNER_BIN],
    runnerArgs: ['--code-dir', join(dir, 'code'), '--grace-ms', '2000'],
    ...(provides === undefined ? {} : { provides }),
  });
  cleanups.unshift(async () => {
    spawned.process.kill('SIGKILL');
    await spawned.exited;
  });
  return spawned;
}

/** Starts the runner on WebSocket, returning its URL once it listens. */
async function listening(dir: string): Promise<string> {
  const child = spawn(
    process.execPath,
    [
      RUNNER_BIN,
      '--store',
      `sqlite:${join(dir, 'store.db')}`,
      '--listen',
      'ws://127.0.0.1:0',
      '--code-dir',
      join(dir, 'code'),
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  cleanups.unshift(async () => {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  });
  return new Promise((resolve, reject) => {
    let output = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      output += chunk;
      const url = /listening on (ws:\/\/\S+)/.exec(output)?.[1];
      if (url !== undefined) resolve(url);
    });
    child.once('exit', () => reject(new Error(`the runner exited: ${output}`)));
  });
}

async function created(client: RunnerClient): Promise<string> {
  const { id } = await client.create('app@1', {});
  if (id === undefined) throw new Error('not created');
  return id;
}

async function until(what: string, condition: () => Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  // Waiting on another process, a little at a time.
  // oxlint-disable-next-line no-await-in-loop
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const results = async (client: RunnerClient, id: string): Promise<Json[]> =>
  (await client.log(id, { kinds: ['result'] })).entries.map((entry) => entry.body);

describe('the protocol', () => {
  it('runs a kind the application provides, with its signal', async () => {
    const dir = await workspace();
    const signalled: string[] = [];
    const { client } = await runner(dir, {
      ask_user: async (ctx) => {
        if (ctx.key === 'slow') {
          await new Promise((resolve) =>
            ctx.signal.addEventListener('abort', resolve, { once: true }),
          );
          signalled.push(ctx.key);
        }
        const page = await ctx.log.list({});
        return { answer: 'yes', attempt: ctx.attempt, entries: page.entries.length };
      },
    });
    await client.deploy(bundle);
    const id = await created(client);
    await client.input(id, {
      kind: 'ask',
      payload: { key: 'q', kind: 'ask_user', args: 'continue?' },
    });
    await until('the answer', async () => (await results(client, id)).length === 1);
    expect(await results(client, id)).toEqual([
      { key: 'q', outcome: { ok: { answer: 'yes', attempt: 1, entries: 0 } } },
    ]);
    await client.input(id, { kind: 'ask', payload: { key: 'slow', kind: 'ask_user' } });
    await until('it to run', async () =>
      (await client.get(id)).running.some((effect) => effect.active),
    );
    await client.input(id, { kind: 'drop', payload: { key: 'slow' } });
    await until('the signal', () => Promise.resolve(signalled.length === 1));
    expect((await client.get(id)).running).toEqual([]);
  });

  it('holds a provided kind until a provider connects, and reruns it after one leaves', async () => {
    const dir = await workspace();
    const listener = await listening(dir);
    const plain = await connectWebSocket(listener);
    cleanups.unshift(() => plain.close());
    await plain.deploy(bundle);
    const id = await created(plain);
    await plain.input(id, { kind: 'ask', payload: { key: 'q', kind: 'ask_user' } });
    await plain.input(id, { kind: 'ask', payload: { key: 'n', kind: 'notify' } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await plain.get(id)).running.map((effect) => [effect.key, effect.active])).toEqual([
      ['q', false],
      ['n', false],
    ]);

    // A provider that never answers, then leaves.
    const leaving = await connectWebSocket(listener, {
      provides: {
        ask_user: () => new Promise<Json>(() => undefined),
        notify: () => new Promise<Json>(() => undefined),
      },
    });
    await until('both running', async () =>
      (await plain.get(id)).running.every((effect) => effect.active),
    );
    await expect(
      connectWebSocket(listener, { provides: { ask_user: () => Promise.resolve(null) } }),
    ).rejects.toMatchObject({
      code: 'kind_taken',
    });
    await leaving.close();
    await until('the once effect reported', async () => (await results(plain, id)).length === 1);
    expect(await results(plain, id)).toEqual([{ key: 'n', outcome: { interrupted: true } }]);

    const answering = await connectWebSocket(listener, {
      provides: { ask_user: (ctx) => Promise.resolve({ attempt: ctx.attempt }) },
    });
    cleanups.unshift(() => answering.close());
    await until('the rerun', async () => (await results(plain, id)).length === 2);
    expect((await results(plain, id))[1]).toEqual({ key: 'q', outcome: { ok: { attempt: 2 } } });
  });

  it('subscribes over WebSocket: history, then each step, view and status', async () => {
    const dir = await workspace();
    const client = await connectWebSocket(await listening(dir));
    cleanups.unshift(() => client.close());
    await client.deploy(bundle);
    const id = await created(client);
    await client.input(id, { kind: 'ask', payload: { key: 'w1', kind: 'work' } });
    await until('the first result', async () => (await results(client, id)).length === 1);
    const events: SessionEvent[] = [];
    const subscription = await client.subscribe(id, {}, (event) => events.push(event));
    await client.input(id, { kind: 'ask', payload: { key: 'w2', kind: 'work', args: { ms: 30 } } });
    await until('the second result', async () => (await results(client, id)).length === 2);
    await until('idle', () => {
      const last = events.at(-1);
      return Promise.resolve(last?.type === 'status' && last.status === 'idle');
    });
    await subscription.close();
    const seqs = events.flatMap((event) =>
      event.type === 'log' ? event.entries.map((entry) => entry.seq) : [],
    );
    expect(seqs).toEqual([1, 2]);
    expect(events).toContainEqual({ type: 'view', view: { asks: 1 } });
    expect(events).toContainEqual({ type: 'status', status: 'busy', fault: null });
  });

  it('passes secrets set over the protocol to handlers', async () => {
    const dir = await workspace();
    const { client } = await runner(dir);
    await client.deploy(bundle);
    await client.setSecret('token', 'from-the-app');
    const id = await created(client);
    await client.input(id, { kind: 'ask', payload: { key: 's', kind: 'secret' } });
    await until('the secret', async () => (await results(client, id)).length === 1);
    expect(await results(client, id)).toEqual([{ key: 's', outcome: { ok: 'from-the-app' } }]);
  });

  it('refuses bad requests with a code', async () => {
    const dir = await workspace();
    const { client } = await runner(dir);
    await expect(client.get('nope')).rejects.toMatchObject({ code: 'no_session' });
    await expect(client.create('missing@1', {})).rejects.toMatchObject({ code: 'no_agent' });
    await expect(client.deploy({ name: 'x', version: '1' })).rejects.toBeInstanceOf(
      RunnerRequestError,
    );
    await client.deploy(bundle);
    await expect(
      client.deploy({ ...bundle, handlers: `${handlers}\n// changed` }),
    ).rejects.toMatchObject({
      code: 'bundle_conflict',
    });
    const id = await created(client);
    expect(await client.input(id, { kind: 'nope' })).toEqual({ rejected: 'unknown input nope' });
  });

  it('deploys from paths', async () => {
    const dir = await workspace();
    await writeFile(join(dir, 'agent.mjs'), agent);
    await writeFile(join(dir, 'handlers.mjs'), handlers);
    const { client } = await runner(dir);
    const deployed = await client.deploy({
      name: 'app',
      version: '1',
      agentPath: join(dir, 'agent.mjs'),
      handlersPath: join(dir, 'handlers.mjs'),
      provides: bundle.provides,
    });
    expect(deployed.deployed).toBe(true);
    expect((await client.deploy(bundle)).deployed).toBe(false);
  });

  it('stops when stdin closes, letting running handlers finish', async () => {
    const dir = await workspace();
    const first = await runner(dir);
    await first.client.deploy(bundle);
    const id = await created(first.client);
    await first.client.input(id, {
      kind: 'ask',
      payload: { key: 'w', kind: 'work', args: { ms: 300 } },
    });
    await first.client.close();
    expect(await first.exited).toBe(0);
    // The handler finished within the grace period: its result was saved to
    // the inbox, and the next start steps it.
    const second = await runner(dir);
    await until('the result', async () => (await results(second.client, id)).length === 1);
    expect(await results(second.client, id)).toEqual([{ key: 'w', outcome: { ok: 'worked' } }]);
  });
});
