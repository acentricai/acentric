// What the engine's tests stand on: one agent with one tool and one input, a store, a clock a
// test moves, and as many engines over the store as a test wants. An engine is a process.

import { Providers } from '@acentric/ai';
import type { ModelRunner } from '@acentric/ai';
import { ScriptedRunner, fakeProvider } from '@acentric/ai/testing';
import type { Scripted } from '@acentric/ai/testing';
import type { ActorEvent, ActorId, AgentDefinition, Json } from '@acentric/protocol';

import { Engine } from '../src/engine.ts';
import type { EngineOptions } from '../src/engine.ts';
import { MemoryStore } from '../src/memory-store.ts';
import type { Store } from '../src/store.ts';
import { InlineExecutor } from '../src/testing.ts';
import type { AgentFunction, InlineAgent } from '../src/testing.ts';
import { instructionsOf } from '../src/scaffold.ts';

/**
 * A store that does what `store` does, but for what `own` does in its place: for a test that
 * counts, or stops, what an engine asks of its store.
 */
export function over(store: Store, own: Partial<Store>): Store {
  const made: { [name: string]: unknown } = {};
  for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(store))) {
    const value = (store as unknown as { [name: string]: unknown })[name];
    if (name !== 'constructor' && typeof value === 'function') {
      made[name] = (value as (...args: unknown[]) => unknown).bind(store);
    }
  }
  return { ...made, ...own } as Store;
}

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
/** What a deploy says of code a test wrote. */
export const MANIFEST = { protocol: 1, sdk: '0.15.0' };
/** The name the tests' agent is deployed under, and what stands for its code. */
export const AGENT = 'orders';
export const CODE = 'orders@1';

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
      /**
       * Other code the engine can be given to deploy, by what stands for it: the agent with
       * some of its definition changed, and some of its functions.
       */
      readonly versions?: {
        readonly [code: string]: {
          readonly definition?: Partial<AgentDefinition>;
          readonly functions?: { readonly [path: string]: AgentFunction };
        };
      };
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
    const versions: { [code: string]: InlineAgent } = {};
    for (const [code, changed] of Object.entries(more.versions ?? {})) {
      versions[code] = {
        definition: { ...definition, ...changed.definition },
        functions: { ...functions, ...changed.functions },
      };
    }
    const executor = new InlineExecutor({ [CODE]: { definition, functions }, ...versions });
    const failures: unknown[] = [];
    const it = new Engine({
      store,
      runner,
      providers: new Providers([fakeProvider(runner)]),
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
    // The agent is deployed the first time it is needed. A second engine on the store finds
    // it deployed, and makes nothing.
    let deployed: ReturnType<Engine['deploy']> | undefined;
    const agent = async () => {
      deployed ??= it.deploy({ agent: AGENT, manifest: MANIFEST, code: CODE });
      return (await deployed).agent;
    };
    return {
      it,
      agent,
      /** Deploys other code as the agent: one of `versions`. */
      deploy: async (code: string, activate = true) => {
        await agent();
        return it.deploy({ agent: AGENT, manifest: MANIFEST, code, activate });
      },
      /** What the scripted model was called with. Empty for a model that is not scripted. */
      steps: runner instanceof ScriptedRunner ? runner.steps : [],
      executor,
      events,
      failures,
      follow: (actor: ActorId) => it.bus.subscribe(actor, (event) => events.push(event)),
      createActor: async (as: Partial<Parameters<Engine['createActor']>[0]> = {}) =>
        (await it.createActor({ agent: (await agent()).id, ...as })).actor,
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
    definition,
    waits,
    roles,
    /** Moves the clock on. */
    advance: (ms: number) => {
      now += ms;
    },
    clock: () => now,
  };
}

/**
 * The instructions a model is sent for an agent that says `own`, on an actor with no machine:
 * what the harness tells every actor, and then the agent's.
 */
export const told = (own: string): string => instructionsOf({ tools: [], machine: null }, own);
