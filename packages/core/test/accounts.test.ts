import { describe, expect, it } from 'vitest';

import { Providers } from '@acentric/ai';
import type { ModelRunner, ModelStep } from '@acentric/ai';
import { fakeProvider, says } from '@acentric/ai/testing';
import { makeId } from '@acentric/protocol';
import type { AccountId, Actor, Agent } from '@acentric/protocol';

import { Accounts } from '../src/accounts.ts';
import { Audit } from '../src/audit.ts';
import { MemoryStore } from '../src/memory-store.ts';
import { Secrets } from '../src/secrets.ts';

const NOW = 1_795_305_600_000;
const BY = { type: 'system' } as const;
let made = 0;
const id = <K extends 'agent' | 'deployment' | 'actor'>(kind: K) => {
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
  /** An actor of an agent, given an account, and archived when `archived` says so. */
  const actor = async (of: Agent, account: AccountId | null, archived = false): Promise<Actor> => {
    const one: Actor = {
      id: id('actor'),
      name: null,
      externalId: null,
      agent: of.id,
      deployment: of.activeDeployment,
      pinned: false,
      behind: null,
      account,
      modelId: 'fake-1',
      reasoning: 'low',
      configuration: null,
      machine: null,
      parent: null,
      status: archived ? 'archived' : 'idle',
      lastTurn: null,
      pendingInputs: 0,
      createdAt: NOW,
      archivedAt: archived ? NOW : null,
    };
    return (await store.createActor(one)).record.actor;
  };
  /** The key an actor's calls are made with now. */
  const keyOf = async (of: Actor) => {
    const access = await accounts.access(of, 'fake');
    await access.runner.run(step, new AbortController().signal);
    return { account: access.account, key: calls.at(-1)?.key };
  };
  return { store, accounts, audit, agent, actor, keyOf };
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
      actors: 0,
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

describe('the account a new actor is given', () => {
  it('is the one asked for, of its agent’s provider, or else that provider’s default', async () => {
    const { accounts } = world();
    const main = await accounts.add(BY, { provider: 'fake', name: 'main', apiKey: 'good' });
    const own = await accounts.add(BY, { provider: 'fake', name: 'own', apiKey: 'better' });
    expect(await accounts.choose('fake')).toBe(main.id);
    expect(await accounts.choose('fake', own.id)).toBe(own.id);
    // A default made later is what the next actor is given.
    await accounts.update(BY, own.id, { default: true });
    expect(await accounts.choose('fake')).toBe(own.id);
  });

  it('is none of another provider’s, or none there is, and is refused while there is none', async () => {
    const { accounts } = world();
    await expect(accounts.choose('fake')).rejects.toThrow(
      'There is no model account for Fake: add one before creating an actor',
    );
    await expect(accounts.choose('fake')).rejects.toMatchObject({ code: 'conflict' });
    const elsewhere = await accounts.add(BY, {
      provider: 'other',
      name: 'elsewhere',
      apiKey: 'good',
    });
    await expect(accounts.choose('fake', elsewhere.id)).rejects.toThrow(
      'The account elsewhere is of other, and the agent of fake',
    );
    await expect(accounts.choose('fake', elsewhere.id)).rejects.toMatchObject({
      code: 'invalid_request',
    });
    const nobody = makeId('account', { now: NOW, random: new Uint8Array(10).fill(9) });
    await expect(accounts.choose('fake', nobody)).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });
});

describe('an actor’s model calls', () => {
  it('are made with the account it was given, whatever the default is now', async () => {
    const { accounts, agent, actor, keyOf } = world();
    const main = await accounts.add(BY, { provider: 'fake', name: 'main', apiKey: 'good' });
    const own = await accounts.add(BY, { provider: 'fake', name: 'own', apiKey: 'better' });
    const orders = await agent('orders');
    const first = await actor(orders, main.id);
    const second = await actor(orders, own.id);
    expect(await keyOf(first)).toEqual({ account: main.id, key: 'good' });
    expect(await keyOf(second)).toEqual({ account: own.id, key: 'better' });
    await accounts.update(BY, own.id, { default: true });
    expect(await keyOf(first)).toEqual({ account: main.id, key: 'good' });
  });

  it('are made with its provider’s default for an actor made before actors had accounts', async () => {
    const { accounts, agent, actor, keyOf } = world();
    const orders = await agent('orders');
    const old = await actor(orders, null);
    await expect(accounts.access(old, 'fake')).rejects.toThrow(
      'There is no model account for Fake: add one before its models are called',
    );
    const main = await accounts.add(BY, { provider: 'fake', name: 'main', apiKey: 'good' });
    expect(await keyOf(old)).toEqual({ account: main.id, key: 'good' });
  });

  it('are made with a key that was replaced from the next call on', async () => {
    const { accounts, agent, actor, keyOf } = world();
    const main = await accounts.add(BY, { provider: 'fake', name: 'main', apiKey: 'good' });
    const one = await actor(await agent('orders'), main.id);
    expect((await keyOf(one)).key).toBe('good');
    await expect(accounts.update(BY, main.id, { apiKey: 'wrong' })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect((await keyOf(one)).key).toBe('good');
    await accounts.update(BY, main.id, { apiKey: 'better' });
    expect((await keyOf(one)).key).toBe('better');
  });
});

describe('an account actors were given', () => {
  it('says how many live ones, and is not removed while any are', async () => {
    const { accounts, store, agent, actor, keyOf } = world();
    const main = await accounts.add(BY, { provider: 'fake', name: 'main', apiKey: 'good' });
    const orders = await agent('orders');
    const live = await actor(orders, main.id);
    const gone = await actor(orders, main.id, true);
    expect((await accounts.get(main.id)).actors).toBe(1);
    const refused = accounts.remove(BY, main.id);
    await expect(refused).rejects.toMatchObject({ code: 'conflict' });
    await expect(refused).rejects.toThrow(
      '1 actor is given this account: archive or delete it first',
    );

    await store.deleteActor(live.id);
    await accounts.remove(BY, main.id);
    await expect(accounts.get(main.id)).rejects.toMatchObject({ code: 'not_found' });
    // The archived one keeps the ID, and is called with the default if it is unarchived.
    expect((await store.loadActor(gone.id))?.actor.account).toBe(main.id);
    const spare = await accounts.add(BY, { provider: 'fake', name: 'spare', apiKey: 'better' });
    expect(await keyOf(gone)).toEqual({ account: spare.id, key: 'better' });
  });
});

describe('the audit log', () => {
  it('has what was done to accounts, and never a key', async () => {
    const { accounts, audit } = world();
    const main = await accounts.add(BY, { provider: 'fake', name: 'main', apiKey: 'good' });
    await accounts.update(BY, main.id, { apiKey: 'better', name: 'primary' });
    await accounts.remove(BY, main.id);

    const { items } = await audit.list({ limit: 100 });
    expect(items.map((event) => event.action).toReversed()).toEqual([
      'account.create',
      'account.update',
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
