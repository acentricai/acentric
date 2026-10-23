// What the conformance scenarios leave to each runner: its built-in kinds,
// secrets, loading, views and what happens after a step it cannot drop.

import type { Agent, Handlers, Json, KindsOf } from '@acentric/types';
import { describe, expect, it } from 'vitest';

import { createMemoryRunner, createMemoryStore } from '../src/index.js';
import type { MemoryRunnerKinds } from '../src/index.js';

type Snapshot = { wake: number | null; asked: boolean; strict: boolean };

const handlers = {
  secret: { mode: 'reissue', run: async (ctx) => ctx.secrets.get('token') },
} satisfies Handlers;

type K = KindsOf<typeof handlers> & MemoryRunnerKinds;

/**
 * Sets a timer when sent `sleep`, reads a secret when sent `ask`, and
 * logs what comes back. Once sent `strict`, it rejects every result.
 */
const agent: Agent<Snapshot, Record<string, never>, K> = {
  name: 'tester',
  version: '1',
  init: () => ({ snapshot: { wake: null, asked: false, strict: false } }),
  step: (state, message, now) => {
    const { snapshot } = state;
    if (message.type === 'input') {
      if (message.kind === 'sleep') return { snapshot: { ...snapshot, wake: now + 20 } };
      if (message.kind === 'ask') return { snapshot: { ...snapshot, asked: true } };
      if (message.kind === 'strict') return { snapshot: { ...snapshot, strict: true } };
      return { error: `unknown input ${message.kind}` };
    }
    if (message.type === 'effect') {
      if (snapshot.strict) throw new Error('no results wanted');
      const next =
        message.kind === '@timer' ? { ...snapshot, wake: null } : { ...snapshot, asked: false };
      return { snapshot: next, append: [{ kind: message.kind, body: message.outcome }] };
    }
    return { snapshot };
  },
  effects: ({ snapshot }) => [
    ...(snapshot.wake === null
      ? []
      : [{ key: `wake-${snapshot.wake}`, kind: '@timer' as const, args: { at: snapshot.wake } }]),
    ...(snapshot.asked ? [{ key: 'ask', kind: 'secret' as const, args: null }] : []),
  ],
  view: ({ snapshot, log }) => ({ sleeping: snapshot.wake !== null, entries: log.next - 1 }),
  handlers,
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bodies(log: readonly { kind: string; body: Json }[]): Json[] {
  return log.map(({ kind, body }) => ({ kind, body }));
}

describe('the memory runner', () => {
  it('fires @timer at its time', async () => {
    const runner = createMemoryRunner();
    const { id } = runner.create(runner.load(agent), {});
    if (id === undefined) throw new Error('not created');
    expect(await runner.input(id, 'sleep', {})).toEqual({ accepted: true });
    expect(runner.running(id)).toMatchObject([{ kind: '@timer', active: false }]);
    await wait(60);
    expect(bodies(runner.log(id))).toEqual([{ kind: '@timer', body: { ok: null } }]);
    expect(runner.running(id)).toEqual([]);
    runner.close();
  });

  it('schedules a timer again after a crash', async () => {
    const store = createMemoryStore();
    const first = createMemoryRunner({ store });
    const { id } = first.create(first.load(agent), {});
    if (id === undefined) throw new Error('not created');
    await first.input(id, 'sleep', {});
    first.close();

    const second = createMemoryRunner({ store });
    second.load(agent);
    second.start();
    await wait(60);
    expect(bodies(second.log(id))).toEqual([{ kind: '@timer', body: { ok: null } }]);
    second.close();
  });

  it('gives handlers its secrets, and fails them when one is missing', async () => {
    const runner = createMemoryRunner({ secrets: { token: 'abc' } });
    const loaded = runner.load(agent);
    const { id } = runner.create(loaded, {});
    if (id === undefined) throw new Error('not created');
    await runner.input(id, 'ask', {});
    await wait(5);
    expect(bodies(runner.log(id))).toEqual([{ kind: 'secret', body: { ok: 'abc' } }]);

    const bare = createMemoryRunner();
    const other = bare.create(bare.load(agent), {}).id;
    if (other === undefined) throw new Error('not created');
    await bare.input(other, 'ask', {});
    await wait(5);
    expect(bare.log(other)).toMatchObject([{ body: { failed: { code: 'threw' } } }]);
    runner.close();
    bare.close();
  });

  it('refuses handlers named with @, and a different agent under a loaded name', () => {
    const runner = createMemoryRunner();
    expect(() => runner.load(agent, { '@timer': handlers.secret })).toThrow(/belong to runners/);
    runner.load(agent);
    expect(() => runner.load({ ...agent })).toThrow(/already loaded as tester@1/);
    expect(() => runner.load(agent)).not.toThrow();
  });

  it('shows the view', async () => {
    const runner = createMemoryRunner();
    const { id } = runner.create(runner.load(agent), {});
    if (id === undefined) throw new Error('not created');
    await runner.input(id, 'sleep', {});
    expect(runner.view(id)).toEqual({ sleeping: true, entries: 0 });
    runner.close();
  });

  it('stops a session whose step fails on a result', async () => {
    const runner = createMemoryRunner({ secrets: { token: 'abc' } });
    const { id } = runner.create(runner.load(agent), {});
    if (id === undefined) throw new Error('not created');
    await runner.input(id, 'strict', {});
    await runner.input(id, 'ask', {});
    await wait(5);
    expect(runner.fault(id)).toMatch(/effect message's step failed/);
    expect(runner.log(id)).toEqual([]);
    expect(await runner.input(id, 'sleep', {})).toMatchObject({ failed: expect.anything() });
    runner.close();
  });

  it('answers nothing once closed', async () => {
    const runner = createMemoryRunner();
    const { id } = runner.create(runner.load(agent), {});
    if (id === undefined) throw new Error('not created');
    runner.close();
    expect(await runner.input(id, 'sleep', {})).toEqual({ failed: 'the runner is closed' });
  });
});
