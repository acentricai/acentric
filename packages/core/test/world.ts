// What the engine's tests stand on: one agent with one tool and one input, a store, a clock a
// test moves, and as many engines over the store as a test wants. An engine is a process.

import type { ModelRunner } from '@acentric/ai';
import { ScriptedRunner } from '@acentric/ai/testing';
import type { Scripted } from '@acentric/ai/testing';
import { makeId } from '@acentric/protocol';
import type { ActorEvent, ActorId, AgentDefinition, DeploymentRef, Json } from '@acentric/protocol';

import { Engine } from '../src/engine.ts';
import type { EngineOptions } from '../src/engine.ts';
import { MemoryStore } from '../src/memory-store.ts';
import type { Store } from '../src/store.ts';
import { InlineExecutor } from '../src/testing.ts';
import type { AgentFunction } from '../src/testing.ts';

/** A promise a test settles when it chooses to. */
export function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * Waits for `check` to hold, giving everything else its turn in between. It waits by the
 * clock, not by a number of turns: a store on a thread of its own answers when it answers.
 */
export async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('It never happened');
}

export const LOOKUP = 'tools.lookup_order.execute';
export const HANDLER = 'inputs.message.handler';

export type World = ReturnType<typeof world>;

export function world(given: { readonly store?: Store; readonly retrySafe?: boolean } = {}) {
  let now = 1_795_305_600_000;
  let made = 0;
  const entropy = () => {
    made += 1;
    return Uint8Array.from(
      [0, 0, 0, 0, 0, 0, made >> 24, made >> 16, made >> 8, made].map((byte) => byte & 255),
    );
  };

  const agent = makeId('agent', { now, random: entropy() });
  const deployment: DeploymentRef = {
    id: makeId('deployment', { now, random: entropy() }),
    version: 1,
  };
  const definition: AgentDefinition = {
    provider: 'fake',
    instructions: 'You answer questions about orders.',
    configuration: null,
    tools: [
      {
        name: 'lookup_order',
        description: 'Finds an order.',
        parameters: { type: 'object' },
        retrySafe: given.retrySafe ?? false,
      },
    ],
    inputs: [{ type: 'message', schema: null }],
  };

  const store: Store = given.store ?? new MemoryStore();
  /** Every wait an engine asked for, in milliseconds. */
  const waits: number[] = [];

  /** An engine over the one store. Each has its own model, executor and bus. */
  const engine = (
    model: readonly Scripted[] | ModelRunner,
    more: {
      readonly lookup?: AgentFunction;
      readonly handler?: AgentFunction;
      readonly options?: Partial<EngineOptions>;
    } = {},
  ) => {
    const runner = 'run' in model ? model : new ScriptedRunner(model);
    const functions: { [path: string]: AgentFunction } = {
      [HANDLER]: more.handler ?? ((payload: Json) => (payload as { text: string }).text),
      [LOOKUP]:
        more.lookup ??
        ((order: Json) => `Order ${String((order as { id: number }).id)} was refunded twice.`),
    };
    const executor = new InlineExecutor(new Map([[deployment.id, { definition, functions }]]));
    const failures: unknown[] = [];
    const it = new Engine({
      store,
      runner,
      executor,
      clock: () => now,
      entropy,
      // A wait is over at once, and the clock is where it would be after it.
      timer: async (ms) => {
        waits.push(ms);
        now += ms;
      },
      report: (error) => failures.push(error),
      ...more.options,
    });
    const events: ActorEvent[] = [];
    return {
      it,
      /** What the scripted model was called with. Empty for a model that is not scripted. */
      steps: runner instanceof ScriptedRunner ? runner.steps : [],
      executor,
      events,
      failures,
      follow: (actor: ActorId) => it.bus.subscribe(actor, (event) => events.push(event)),
      createActor: async () =>
        (await it.createActor({ agent, deployment, modelId: 'fake-1' })).actor,
      say: (actor: ActorId, text: string, externalId?: string) =>
        it.send(actor, {
          type: 'message',
          payload: { text },
          ...(externalId === undefined ? {} : { externalId }),
        }),
    };
  };

  const roles = async (actor: ActorId) =>
    (await store.conversation(actor)).map((entry) => entry.message.role);

  return {
    store,
    engine,
    agent,
    deployment,
    waits,
    roles,
    /** Moves the clock on. */
    advance: (ms: number) => {
      now += ms;
    },
    clock: () => now,
  };
}
