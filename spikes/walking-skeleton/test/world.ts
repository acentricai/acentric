// What every test of the skeleton stands on: one agent with one tool and one input, a store,
// and as many engines over that store as a test wants.

import { makeId } from '@acentric/protocol';
import type { ActorEvent, AgentDefinition, DeploymentRef, Json } from '@acentric/protocol';

import { Engine } from '../src/engine.ts';
import { InlineExecutor, MemoryBus, MemoryStore, ScriptedRunner } from '../src/fakes.ts';
import type { AgentFunction, Scripted } from '../src/fakes.ts';

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

/** Waits for `check` to hold. Nothing here uses a timer, so it is a matter of turns of the loop. */
export async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let tries = 0; tries < 10_000; tries += 1) {
    if (await check()) return;
    await Promise.resolve();
  }
  throw new Error('It never happened');
}

export const LOOKUP = 'tools.lookup_order.execute';
export const HANDLER = 'inputs.message.handler';

export function world(options: { readonly retrySafe?: boolean } = {}) {
  let now = 1_795_305_600_000;
  const clock = () => (now += 1);
  let made = 0;
  const entropy = () => {
    made += 1;
    return Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, made >> 8, made & 255]);
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
        retrySafe: options.retrySafe ?? false,
      },
    ],
    inputs: [{ type: 'message', schema: null }],
  };

  const store = new MemoryStore();

  /** An engine over the one store: a process. Each has its own model, executor and bus. */
  const engine = (script: readonly Scripted[], lookup?: AgentFunction) => {
    const runner = new ScriptedRunner(script);
    const functions: { [path: string]: AgentFunction } = {
      [HANDLER]: (payload: Json) => (payload as { text: string }).text,
      [LOOKUP]:
        lookup ??
        ((order: Json) => `Order ${String((order as { id: number }).id)} was refunded twice.`),
    };
    const executor = new InlineExecutor(new Map([[deployment.id, { definition, functions }]]));
    const bus = new MemoryBus();
    const it = new Engine({ store, runner, executor, bus, clock, entropy });
    const events: ActorEvent[] = [];
    return {
      it,
      runner,
      executor,
      events,
      follow: (actor: Parameters<MemoryBus['subscribe']>[0]) =>
        bus.subscribe(actor, (event) => events.push(event)),
      createActor: () => it.createActor({ agent, deployment, model: 'fake-1' }),
    };
  };

  return { store, engine, agent, deployment };
}
