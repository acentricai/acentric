// What the API's tests stand on: the whole API over an engine in memory, with a model that
// says what a test wrote, called through the client a program would call it with.

import { Providers } from '@acentric/ai';
import { ScriptedRunner, fakeProvider } from '@acentric/ai/testing';
import type { Scripted } from '@acentric/ai/testing';
import { createClient } from '@acentric/client';
import type { Client } from '@acentric/client';
import {
  Accounts,
  Audit,
  Engine,
  Keys,
  MemoryBlobStore,
  MemoryStore,
  People,
  Secrets,
  accountRunners,
} from '@acentric/core';
import type { EngineOptions, TaskKind } from '@acentric/core';
import { InlineExecutor } from '@acentric/core/testing';
import type { AgentFunction, InlineAgent } from '@acentric/core/testing';
import type { ActorId, AgentDefinition, BodyOf, Json } from '@acentric/protocol';

import { Streams, createApp } from '../src/index.ts';

export const ADMIN = 'the-key-this-engine-was-started-with';
export const MANIFEST = { protocol: 1, sdk: '0.15.0' };
export const BASE = 'http://engine.test';

const definition: AgentDefinition = {
  provider: 'fake',
  instructions: 'You answer questions about orders.',
  configuration: null,
  tools: [
    {
      name: 'lookup_order',
      description: 'Finds an order.',
      parameters: { type: 'object' },
      retrySafe: false,
    },
  ],
  inputs: [{ type: 'message', schema: null }],
  secrets: ['ORDERS_API_KEY'],
};

const functions: { [path: string]: AgentFunction } = {
  'inputs.message.handler': (payload: Json) => {
    // A message that is content already, such as one with an image, is what the model reads.
    const { content } = (payload ?? {}) as { content?: Json };
    if (Array.isArray(content)) return content;
    const text = (payload as { text?: unknown } | null)?.text;
    if (typeof text !== 'string') throw new Error('text is required');
    return text;
  },
  'tools.lookup_order.execute': (order: Json) =>
    `Order ${String((order as { id: number }).id)} was refunded twice.`,
};

/** The code a test can deploy, by what stands for it. */
const AGENTS: { [code: string]: InlineAgent } = {
  'orders@1': { definition, functions },
  'orders@2': { definition: { ...definition, instructions: 'You are kind.' }, functions },
  'billing@1': { definition: { ...definition, instructions: 'You bill.' }, functions },
  'machines@1': { definition: { ...definition, features: ['machine'] }, functions },
  // An agent whose actors can spawn actors of `billing`.
  'lead@1': {
    definition: {
      ...definition,
      instructions: 'You lead.',
      features: ['subagents'],
      subagents: [{ agent: 'billing', description: 'Bills an order.', creates: false }],
    },
    functions,
  },
};

export type Api = Awaited<ReturnType<typeof api>>;

/** The keys the provider of these tests takes. */
export const MODEL_KEY = 'a-key-the-fake-provider-takes';
export const OTHER_MODEL_KEY = 'another-key-the-fake-provider-takes';

export async function api(
  script: readonly Scripted[] = [],
  options: {
    readonly secretKey?: boolean;
    /** False for an engine that was added no model account. */
    readonly account?: boolean;
    /** False for an engine with no blob store: images stay in their messages. */
    readonly blobs?: boolean;
    /** The kinds of task the engine has. None, without it. */
    readonly kinds?: readonly TaskKind[];
    /** True for an engine that keeps machines. */
    readonly machines?: boolean;
    /** The providers its sandboxes are made at, for an engine that keeps machines. */
    readonly sandboxes?: NonNullable<EngineOptions['sandboxes']>;
  } = {},
) {
  const store = new MemoryStore();
  const blobs = new MemoryBlobStore();
  const runner = new ScriptedRunner(script);
  const sealing = options.secretKey !== false;
  const secrets = new Secrets({
    store,
    ...(sealing ? { keys: { current: 'k1', keys: { k1: new Uint8Array(32).fill(1) } } } : {}),
  });
  const providers = new Providers([fakeProvider(runner, { keys: [MODEL_KEY, OTHER_MODEL_KEY] })]);
  const audit = new Audit({ store });
  const accounts = new Accounts({ store, secrets, providers, audit });
  // The account every agent's model is called with, unless a test is of an engine with none.
  // It is added as an engine that was set up before the test would have it: by nobody the
  // audit log of the test names.
  const account =
    sealing && options.account !== false
      ? await new Accounts({ store, secrets, providers }).add(
          { type: 'system' },
          { provider: 'fake', name: 'main', apiKey: MODEL_KEY },
        )
      : undefined;
  const engine = new Engine({
    store,
    // An engine that seals nothing has no account: its model is called without one.
    runner: sealing ? accountRunners(accounts) : runner,
    providers,
    executor: new InlineExecutor(AGENTS),
    secrets,
    ...(options.blobs === false ? {} : { blobs }),
    ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
    ...(options.machines === true ? { machines: {} } : {}),
    ...(options.sandboxes === undefined ? {} : { sandboxes: options.sandboxes }),
  });
  // A hash that is quick to make: these tests are not of how long a password takes to guess.
  const people = new People({ store, audit, passwordCost: 1024 });
  const keys = new Keys({
    store,
    settingsKey: ADMIN,
    agentOf: async (actor) => (await store.loadActor(actor))?.actor.agent,
    holderOf: (user) => people.holder(user),
  });
  const streams = new Streams();
  /** What the server itself failed at. */
  const failures: unknown[] = [];
  const app = createApp({
    engine,
    keys,
    people,
    audit,
    secrets,
    accounts,
    streams,
    version: 'test',
    // Every answer is held to its route's schema.
    checkAnswers: true,
    report: (error) => failures.push(error),
  });
  /** A client that calls with a key, or with none. */
  const as = (token?: string): Client =>
    createClient({
      baseUrl: BASE,
      ...(token === undefined ? {} : { token }),
      fetch: async (input, init) => app.request(String(input), init),
    });
  const admin = as(ADMIN);

  /** Deploys code as an agent of a name. */
  const deploy = (name = 'orders', code = 'orders@1', by: Client = admin) =>
    by.call('deployments.create', { body: { agent: name, manifest: MANIFEST, code } });
  /** A client with a key the admin made. */
  const keyed = async (
    given: Pick<BodyOf<'keys.create'>, 'scope' | 'permissions' | 'expiresAt'>,
  ) => {
    const made = await admin.call('keys.create', { body: { label: 'for a test', ...given } });
    return { ...made, client: as(made.token) };
  };
  /** Sends an actor a message, and waits until it has nothing left to do. */
  const say = async (actor: ActorId, text: string) => {
    const sent = await admin.call('inputs.send', {
      params: { actor },
      body: { type: 'message', payload: { text } },
    });
    await engine.settled(actor);
    return sent;
  };

  return {
    app,
    store,
    blobs,
    engine,
    keys,
    people,
    audit,
    secrets,
    accounts,
    account,
    streams,
    runner,
    failures,
    as,
    admin,
    deploy,
    keyed,
    say,
  };
}

/** The code and the status a call was refused with. */
export async function refusal(call: Promise<unknown>): Promise<{ code: string; status: number }> {
  try {
    await call;
  } catch (error) {
    const { code, status } = error as { code: string; status: number };
    return { code, status };
  }
  throw new Error('The call was not refused');
}
