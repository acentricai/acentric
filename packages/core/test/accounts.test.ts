import { describe, expect, it } from 'vitest';

import { Providers } from '@acentric/ai';
import type { ModelRunner, ModelStep } from '@acentric/ai';
import { fakeProvider, says } from '@acentric/ai/testing';
import { makeId } from '@acentric/protocol';
import type { Agent } from '@acentric/protocol';

import { Accounts } from '../src/accounts.ts';
import { Audit } from '../src/audit.ts';
import { MemoryStore } from '../src/memory-store.ts';
import { Secrets } from '../src/secrets.ts';

const NOW = 1_795_305_600_000;
const BY = { type: 'system' } as const;
let made = 0;
const id = <K extends 'agent' | 'deployment'>(kind: K) => {
  made += 1;
  return makeId(kind, { now: NOW, random: Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, made]) });
};

function world(keys: boolean = true) {
  const store = new MemoryStore();
  const audit = new Audit({ store, clock: () => NOW });
  const secrets = new Secrets({
    store,
    ...(keys ? { keys: { current: 'k1', keys: { k1: new Uint8Array(32).fill(1) } } } : {}),
  });
  /** What each runner was made with, and called with. */
  const calls: { readonly key: string; readonly step: ModelStep }[] = [];
  const provider = (name: string) => ({
    ...fakeProvider({ run: async () => says('unused') }, { keys: ['good', 'better'] }),
    id: name,
    label: name === 'fake' ? 'Fake' : 'Other',
    runner: ({ credential }: { credential: { type: string; apiKey?: string } }): ModelRunner => ({
      async run(step) {
        calls.push({ key: credential.apiKey ?? '', step });
        return says('Hello.');
      },
    }),
  });
  const signedIn = { ...provider('signed-in'), credentials: ['access_token'] as const };
  const providers = new Providers([provider('fake'), provider('other'), signedIn]);
  const accounts = new Accounts({ store, secrets, providers, audit, clock: () => NOW });
  /** An agent of a provider, as a deploy makes one. */
  const agent = async (name: string, of = 'fake'): Promise<Agent> => {
    const agentId = id('agent');
    const ref = { id: id('deployment'), version: 1 };
    const one: Agent = {
      id: agentId,
      name,
      provider: of,
      activeDeployment: ref,
      latestDeployment: ref,
      account: null,
      createdAt: NOW,
    };
    await store.addDeployment({
      agent: one,
      deployment: {
        ...ref,
        agent: agentId,
        hash: 'a'.repeat(64),
        manifest: { protocol: 1, sdk: '0.15.0' },
        definition: { provider: of, instructions: '', configuration: null, tools: [], inputs: [] },
        createdBy: BY,
        createdAt: NOW,
      },
      code: name,
    });
    return one;
  };
  const step: ModelStep = {
    model: 'fake-1',
    reasoning: 'low',
    instructions: '',
    tools: [],
    messages: [],
  };
  /** The key an agent's calls are made with now. */
  const keyOf = async (of: Agent) => {
    const access = await accounts.access(of.id);
    await access.runner.run(step, new AbortController().signal);
    return { account: access.account, key: calls.at(-1)?.key };
  };
  return { store, accounts, audit, agent, keyOf };
}

describe('a model account', () => {
  it('is kept once its provider has taken its key, and never gives the key back', async () => {
    const { accounts, store } = world();
    const account = await accounts.add(BY, { provider: 'fake', name: 'main', apiKey: ' good ' });
    expect(account).toMatchObject({
      provider: 'fake',
      name: 'main',
      credential: 'api_key',
      // The first of its provider is that provider's default.
      default: true,
      owner: null,
      agents: [],
      createdBy: BY,
    });
    expect(await accounts.get(account.id)).toEqual(account);
    expect(await accounts.list()).toEqual([account]);
    // What is kept of the key is sealed.
    const kept = await store.loadAccount(account.id);
    expect(kept?.sealed).toMatch(/^v1\.k1\./);
    expect(JSON.stringify([kept, account])).not.toContain('good');
  });

  it('is refused when its provider refuses its key, could not be asked, or is not one', async () => {
    const { accounts } = world();
    const add = (provider: string, apiKey: string) =>
      accounts.add(BY, { provider, name: 'main', apiKey });
    await expect(add('fake', 'wrong')).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(add('fake', 'wrong')).rejects.toThrow(/refused the key/);
    await expect(add('fake', 'unreachable')).rejects.toMatchObject({ code: 'provider_failed' });
    await expect(add('nowhere', 'good')).rejects.toThrow(/There is no provider nowhere/);
    // A provider people sign in to has no account made with a key.
    await expect(add('signed-in', 'good')).rejects.toThrow(/made by signing in/);
    expect(await accounts.list()).toEqual([]);
  });

  it('cannot be kept by an engine that was given no key to seal with', async () => {
    const { accounts } = world(false);
    await expect(
      accounts.add(BY, { provider: 'fake', name: 'main', apiKey: 'good' }),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(await accounts.list()).toEqual([]);
  });

  it('has a name of its own', async () => {
    const { accounts } = world();
    await accounts.add(BY, { provider: 'fake', name: 'main', apiKey: 'good' });
    const spare = await accounts.add(BY, { provider: 'other', name: 'spare', apiKey: 'good' });
    await expect(
      accounts.add(BY, { provider: 'other', name: 'main', apiKey: 'good' }),
    ).rejects.toMatchObject({ code: 'name_taken' });
    await expect(accounts.update(BY, spare.id, { name: 'main' })).rejects.toMatchObject({
      code: 'name_taken',
    });
    expect((await accounts.update(BY, spare.id, { name: 'backup' })).name).toBe('backup');
  });
});

describe('a provider’s default account', () => {
  it('is the first, until another is made it: there is always one, and only one', async () => {
    const { accounts } = world();
    const first = await accounts.add(BY, { provider: 'fake', name: 'first', apiKey: 'good' });
    const second = await accounts.add(BY, { provider: 'fake', name: 'second', apiKey: 'good' });
    const elsewhere = await accounts.add(BY, {
      provider: 'other',
      name: 'elsewhere',
      apiKey: 'good',
    });
    const defaults = async () =>
      (await accounts.list()).filter((account) => account.default).map((account) => account.name);
    expect(await defaults()).toEqual(['first', 'elsewhere']);

    await accounts.update(BY, second.id, { default: true });
    expect(await defaults()).toEqual(['second', 'elsewhere']);
    const third = await accounts.add(BY, {
      provider: 'fake',
      name: 'third',
      apiKey: 'good',
      default: true,
    });
    expect(await defaults()).toEqual(['elsewhere', 'third']);

    // Removed, the oldest of its provider's others is the default.
    await accounts.remove(BY, third.id);
    expect(await defaults()).toEqual(['first', 'elsewhere']);
    await accounts.remove(BY, elsewhere.id);
    expect(await defaults()).toEqual(['first']);
    expect(first.default).toBe(true);
  });
});

describe('an agent’s model calls', () => {
  it('are made with its provider’s default account, or with the one it was given', async () => {
    const { accounts, agent, keyOf } = world();
    const main = await accounts.add(BY, { provider: 'fake', name: 'main', apiKey: 'good' });
    const own = await accounts.add(BY, { provider: 'fake', name: 'own', apiKey: 'better' });
    const orders = await agent('orders');
    expect(await keyOf(orders)).toEqual({ account: main.id, key: 'good' });

    const given = await accounts.give(BY, orders, own.id);
    expect(given.account).toBe(own.id);
    expect(await keyOf(orders)).toEqual({ account: own.id, key: 'better' });
    expect((await accounts.get(own.id)).agents).toEqual([orders.id]);

    expect((await accounts.give(BY, given, null)).account).toBeNull();
    expect(await keyOf(orders)).toEqual({ account: main.id, key: 'good' });
  });

  it('are made with a key that was replaced from the next call on', async () => {
    const { accounts, agent, keyOf } = world();
    const main = await accounts.add(BY, { provider: 'fake', name: 'main', apiKey: 'good' });
    const orders = await agent('orders');
    expect((await keyOf(orders)).key).toBe('good');
    await expect(accounts.update(BY, main.id, { apiKey: 'wrong' })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect((await keyOf(orders)).key).toBe('good');
    await accounts.update(BY, main.id, { apiKey: 'better' });
    expect((await keyOf(orders)).key).toBe('better');
  });

  it('cannot be made while its provider has no account, and say what to do about it', async () => {
    const { accounts, agent } = world();
    await accounts.add(BY, { provider: 'other', name: 'elsewhere', apiKey: 'good' });
    const orders = await agent('orders');
    await expect(accounts.access(orders.id)).rejects.toThrow(
      'There is no model account for Fake: add one before its models are called',
    );
  });

  it('are not given an account of another provider, and an account that is given is not removed', async () => {
    const { accounts, agent } = world();
    const main = await accounts.add(BY, { provider: 'fake', name: 'main', apiKey: 'good' });
    const elsewhere = await accounts.add(BY, {
      provider: 'other',
      name: 'elsewhere',
      apiKey: 'good',
    });
    const orders = await agent('orders');
    await expect(accounts.give(BY, orders, elsewhere.id)).rejects.toMatchObject({
      code: 'conflict',
    });
    const nobody = makeId('account', { now: NOW, random: new Uint8Array(10).fill(9) });
    await expect(accounts.give(BY, orders, nobody)).rejects.toMatchObject({ code: 'not_found' });

    await accounts.give(BY, orders, main.id);
    const refused = accounts.remove(BY, main.id);
    await expect(refused).rejects.toMatchObject({ code: 'conflict' });
    await expect(refused).rejects.toThrow(/give them another first/);
    await accounts.give(BY, { ...orders, account: main.id }, null);
    await accounts.remove(BY, main.id);
    await expect(accounts.get(main.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('the audit log', () => {
  it('has what was done to accounts, and never a key', async () => {
    const { accounts, audit, agent } = world();
    const main = await accounts.add(BY, { provider: 'fake', name: 'main', apiKey: 'good' });
    await accounts.update(BY, main.id, { apiKey: 'better', name: 'primary' });
    const orders = await agent('orders');
    await accounts.give(BY, orders, main.id);
    await accounts.give(BY, { ...orders, account: main.id }, null);
    await accounts.remove(BY, main.id);

    const { items } = await audit.list({ limit: 100 });
    expect(items.map((event) => event.action).toReversed()).toEqual([
      'account.create',
      'account.update',
      'agent.account',
      'agent.account',
      'account.delete',
    ]);
    expect(items.find((event) => event.action === 'account.update')?.detail).toEqual({
      name: 'primary',
      key: 'replaced',
    });
    const written = JSON.stringify(items);
    expect(written).not.toContain('good');
    expect(written).not.toContain('better');
  });
});
