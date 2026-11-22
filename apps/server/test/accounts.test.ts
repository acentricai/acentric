// Model accounts and usage, through the API, called as a program calls it.

import { describe, expect, it } from 'vitest';

import { calls, says } from '@acentric/ai/testing';
import type { QueryGiven } from '@acentric/client';
import { makeId } from '@acentric/protocol';
import type { UsageTotals } from '@acentric/protocol';

import { MODEL_KEY, OTHER_MODEL_KEY, api, refusal } from './api.ts';

const lookup = calls({ id: 'c1', name: 'lookup_order', arguments: { id: 4411 } });
const used = { totalInput: 40, input: 30, cacheRead: 10, output: 5 };
const cost = { total: 0.002, source: 'reported' } as const;
const nobody = makeId('account', { now: 1_795_305_600_000, random: new Uint8Array(10).fill(9) });

describe('model accounts', () => {
  it('are added once their provider takes their key, listed, read, and never give it back', async () => {
    const { admin, failures } = await api([], { account: false });
    const main = await admin.call('accounts.create', {
      body: { provider: 'fake', name: 'main', apiKey: MODEL_KEY },
    });
    expect(main).toMatchObject({
      provider: 'fake',
      name: 'main',
      credential: 'api_key',
      default: true,
      owner: null,
      agents: [],
    });
    const spare = await admin.call('accounts.create', {
      body: { provider: 'fake', name: 'spare', apiKey: ` ${OTHER_MODEL_KEY} ` },
    });
    expect(spare.default).toBe(false);

    const listed = await admin.call('accounts.list');
    expect(listed).toEqual({ items: [main, spare], nextCursor: null });
    const page = await admin.call('accounts.list', { query: { limit: 1 } });
    expect(page).toEqual({ items: [main], nextCursor: main.id });
    expect(
      (await admin.call('accounts.list', { query: { limit: 1, cursor: main.id } })).items,
    ).toEqual([spare]);
    expect(await admin.call('accounts.get', { params: { account: spare.id } })).toEqual(spare);

    const told = JSON.stringify([main, spare, listed]);
    expect(told).not.toContain(MODEL_KEY);
    expect(told).not.toContain(OTHER_MODEL_KEY);
    expect(failures).toEqual([]);
  });

  it('are refused with a key their provider does not take, or a provider there is not', async () => {
    const { admin } = await api([], { account: false });
    const add = (body: { provider: string; name: string; apiKey: string }) =>
      refusal(admin.call('accounts.create', { body }));
    expect(await add({ provider: 'fake', name: 'main', apiKey: 'a-wrong-key' })).toEqual({
      code: 'invalid_request',
      status: 400,
    });
    expect(await add({ provider: 'nowhere', name: 'main', apiKey: MODEL_KEY })).toEqual({
      code: 'invalid_request',
      status: 400,
    });
    // The provider could not be asked: the same request may work later.
    expect(await add({ provider: 'fake', name: 'main', apiKey: 'unreachable' })).toMatchObject({
      code: 'provider_failed',
    });
    expect(await add({ provider: 'fake', name: 'main', apiKey: '  ' })).toMatchObject({
      status: 400,
    });
    expect((await admin.call('accounts.list')).items).toEqual([]);

    await admin.call('accounts.create', {
      body: { provider: 'fake', name: 'main', apiKey: MODEL_KEY },
    });
    expect(await add({ provider: 'fake', name: 'main', apiKey: MODEL_KEY })).toEqual({
      code: 'name_taken',
      status: 409,
    });
  });

  it('are changed: their name, their key, and which is their provider’s default', async () => {
    const { admin, account } = await api();
    const main = account?.id ?? nobody;
    const spare = await admin.call('accounts.create', {
      body: { provider: 'fake', name: 'spare', apiKey: MODEL_KEY },
    });
    const changed = await admin.call('accounts.update', {
      params: { account: spare.id },
      body: { name: 'backup', apiKey: OTHER_MODEL_KEY, default: true },
    });
    expect(changed).toMatchObject({ id: spare.id, name: 'backup', default: true });
    expect(JSON.stringify(changed)).not.toContain(OTHER_MODEL_KEY);
    // There is one default for a provider.
    expect((await admin.call('accounts.get', { params: { account: main } })).default).toBe(false);

    const update = (body: { name?: string; apiKey?: string }) =>
      refusal(admin.call('accounts.update', { params: { account: spare.id }, body }));
    expect(await update({ apiKey: 'a-wrong-key' })).toEqual({
      code: 'invalid_request',
      status: 400,
    });
    expect(await update({ name: 'main' })).toEqual({ code: 'name_taken', status: 409 });
    expect(
      await refusal(
        admin.call('accounts.update', { params: { account: nobody }, body: { name: 'x' } }),
      ),
    ).toEqual({ code: 'not_found', status: 404 });
  });

  it('are removed, unless an agent is given them', async () => {
    const { admin, deploy, account } = await api();
    const main = account?.id ?? nobody;
    const { agent } = await deploy();
    await admin.call('agents.update', { params: { agent: agent.id }, body: { account: main } });
    expect(await refusal(admin.call('accounts.delete', { params: { account: main } }))).toEqual({
      code: 'conflict',
      status: 409,
    });
    await admin.call('agents.update', { params: { agent: agent.id }, body: { account: null } });
    expect(await admin.call('accounts.delete', { params: { account: main } })).toBeUndefined();
    expect(await refusal(admin.call('accounts.get', { params: { account: main } }))).toEqual({
      code: 'not_found',
      status: 404,
    });
    expect(await refusal(admin.call('accounts.delete', { params: { account: main } }))).toEqual({
      code: 'not_found',
      status: 404,
    });
  });

  it('are for a key of the whole engine that may manage them, and no other', async () => {
    const { deploy, keyed, account } = await api();
    const main = account?.id ?? nobody;
    const { agent } = await deploy();
    const forbidden = { code: 'forbidden', status: 403 };
    const reader = await keyed({ scope: { type: 'engine' }, permissions: ['agents:read'] });
    const ofAgent = await keyed({
      scope: { type: 'agent', agent: agent.id },
      permissions: ['agents:read', 'agents:deploy'],
    });
    for (const { client } of [reader, ofAgent]) {
      expect(await refusal(client.call('accounts.list'))).toEqual(forbidden);
      expect(await refusal(client.call('accounts.get', { params: { account: main } }))).toEqual(
        forbidden,
      );
      expect(
        await refusal(
          client.call('accounts.create', {
            body: { provider: 'fake', name: 'mine', apiKey: MODEL_KEY },
          }),
        ),
      ).toEqual(forbidden);
      expect(await refusal(client.call('accounts.delete', { params: { account: main } }))).toEqual(
        forbidden,
      );
    }
  });

  it('are refused by a server that was given no key to seal them with', async () => {
    const { admin } = await api([], { secretKey: false });
    expect(
      await refusal(
        admin.call('accounts.create', {
          body: { provider: 'fake', name: 'main', apiKey: MODEL_KEY },
        }),
      ),
    ).toEqual({ code: 'unavailable', status: 503 });
  });

  it('are in the audit log with who changed them, and their keys are not', async () => {
    const { admin, deploy } = await api([], { account: false });
    const main = await admin.call('accounts.create', {
      body: { provider: 'fake', name: 'main', apiKey: MODEL_KEY },
    });
    await admin.call('accounts.update', {
      params: { account: main.id },
      body: { apiKey: OTHER_MODEL_KEY },
    });
    const { agent } = await deploy();
    await admin.call('agents.update', { params: { agent: agent.id }, body: { account: main.id } });
    await admin.call('agents.update', { params: { agent: agent.id }, body: { account: null } });
    await admin.call('accounts.delete', { params: { account: main.id } });

    const { items } = await admin.call('audit.list', { query: { limit: 100 } });
    const of = items.filter((event) => /account/.test(event.action)).toReversed();
    expect(of.map((event) => [event.action, event.by.type, event.target])).toEqual([
      ['account.create', 'key', { type: 'account', id: main.id }],
      ['account.update', 'key', { type: 'account', id: main.id }],
      ['agent.account', 'key', { type: 'agent', id: agent.id }],
      ['agent.account', 'key', { type: 'agent', id: agent.id }],
      ['account.delete', 'key', { type: 'account', id: main.id }],
    ]);
    const written = JSON.stringify(items);
    expect(written).not.toContain(MODEL_KEY);
    expect(written).not.toContain(OTHER_MODEL_KEY);
  });
});

describe('an agent’s model', () => {
  it('cannot be called while its provider has no account: the turn fails, with what to do', async () => {
    const { admin, engine, deploy, say, failures } = await api([says('Hello.')], {
      account: false,
    });
    const { agent } = await deploy();
    expect(agent.account).toBeNull();
    const { actor } = await admin.call('actors.create', { params: { agent: agent.id }, body: {} });
    await say(actor.id, 'Hello?');
    expect(
      (await admin.call('actors.get', { params: { actor: actor.id } })).lastTurn,
    ).toMatchObject({
      end: 'failed',
      reason: 'There is no model account for Fake: add one before its models are called',
    });
    expect((await admin.call('usage.get')).totals.calls).toBe(0);

    // With one added, the turn that failed is tried again.
    await admin.call('accounts.create', {
      body: { provider: 'fake', name: 'main', apiKey: MODEL_KEY },
    });
    await admin.call('actors.retry', { params: { actor: actor.id } });
    await engine.settled(actor.id);
    expect((await admin.call('actors.get', { params: { actor: actor.id } })).lastTurn?.end).toBe(
      'ok',
    );
    expect(failures).toEqual([]);
  });

  it('is called with the account the agent was given, and with the default again when it has none', async () => {
    const answer = { ...says('Hello.'), usage: used };
    const { admin, deploy, say, account } = await api([answer, answer, answer]);
    const main = account?.id ?? nobody;
    const own = await admin.call('accounts.create', {
      body: { provider: 'fake', name: 'own', apiKey: OTHER_MODEL_KEY },
    });
    const { agent } = await deploy();
    const { actor } = await admin.call('actors.create', { params: { agent: agent.id }, body: {} });
    const byAccount = async () =>
      (await admin.call('usage.get', { query: { by: 'account' } })).groups?.map((group) => [
        group.key,
        group.totals.calls,
      ]);

    await say(actor.id, 'One.');
    expect(await byAccount()).toEqual([[main, 1]]);

    const given = await admin.call('agents.update', {
      params: { agent: agent.id },
      body: { account: own.id },
    });
    expect(given.account).toBe(own.id);
    expect((await admin.call('agents.get', { params: { agent: agent.id } })).account).toBe(own.id);
    expect((await admin.call('accounts.get', { params: { account: own.id } })).agents).toEqual([
      agent.id,
    ]);
    // An actor that is already running is called with it from its next call on.
    await say(actor.id, 'Two.');
    expect(await byAccount()).toEqual([
      [main, 1],
      [own.id, 1],
    ]);

    const back = await admin.call('agents.update', {
      params: { agent: agent.id },
      body: { account: null },
    });
    expect(back.account).toBeNull();
    await say(actor.id, 'Three.');
    expect(await byAccount()).toEqual([
      [main, 2],
      [own.id, 1],
    ]);
  });

  it('keeps its account when the agent is deployed again, or a version is made active', async () => {
    const { admin, deploy, account } = await api();
    const main = account?.id ?? nobody;
    const { agent } = await deploy();
    await admin.call('agents.update', { params: { agent: agent.id }, body: { account: main } });
    expect((await deploy('orders', 'orders@2')).agent.account).toBe(main);
    // A version and an account in one request are both done.
    const both = await admin.call('agents.update', {
      params: { agent: agent.id },
      body: { activeVersion: 1, account: null },
    });
    expect(both).toMatchObject({ activeDeployment: { version: 1 }, account: null });
  });

  it('is not given what is no account of its provider, and a request that fails changes nothing', async () => {
    const { admin, deploy, account } = await api();
    const main = account?.id ?? nobody;
    const { agent } = await deploy();
    const update = (body: { activeVersion?: number; account?: typeof main | null }) =>
      refusal(admin.call('agents.update', { params: { agent: agent.id }, body }));
    expect(await update({ account: nobody })).toEqual({ code: 'not_found', status: 404 });
    expect(await update({})).toEqual({ code: 'invalid_request', status: 400 });
    // There is no version 9: the account is not given either.
    expect(await update({ activeVersion: 9, account: main })).toEqual({
      code: 'not_found',
      status: 404,
    });
    expect((await admin.call('agents.get', { params: { agent: agent.id } })).account).toBeNull();
  });
});

describe('usage', () => {
  /** Two agents with an actor each: `orders` made three calls of the model, `billing` one. */
  async function spent() {
    const one = await api([
      { ...lookup, usage: used },
      { ...says('It was refunded twice.'), usage: { ...used, cost } },
      () => {
        throw new Error('The provider fell over');
      },
      { ...says('You owe nothing.'), usage: { ...used, cost } },
    ]);
    const { admin, deploy, say } = one;
    const orders = (await deploy()).agent;
    const billing = (await deploy('billing', 'billing@1')).agent;
    const create = async (agent: typeof orders) =>
      (await admin.call('actors.create', { params: { agent: agent.id }, body: {} })).actor;
    const first = await create(orders);
    const second = await create(billing);
    await say(first.id, 'What happened to order 4411?');
    await say(first.id, 'And then?');
    await say(second.id, 'What do I owe?');
    return { ...one, orders, billing, first, second };
  }
  const brief = ({
    calls: made,
    failed,
    totalInput,
    output,
    cost: spentOn,
    unpriced,
  }: UsageTotals) => ({
    calls: made,
    failed,
    totalInput,
    output,
    cost: spentOn,
    unpriced,
  });

  it('adds up every call of a model: tokens, cost, how long, and how many failed', async () => {
    const { admin, failures } = await spent();
    const { totals, groups } = await admin.call('usage.get');
    expect(groups).toBeUndefined();
    expect(totals).toMatchObject({
      calls: 4,
      failed: 1,
      totalInput: 120,
      input: 90,
      cacheRead: 30,
      cacheWrite: 0,
      output: 15,
      cost: 0.004,
      // What the provider said it cost is not an estimate.
      estimatedCost: 0,
      unpriced: 1,
    });
    expect(totals.first).toBeLessThanOrEqual(totals.last ?? 0);
    expect(failures).toEqual([]);
  });

  it('is narrowed, and added up by agent, actor, account, provider, model or day', async () => {
    const { admin, orders, billing, first, second, account } = await spent();
    const get = async (query: QueryGiven<'usage.get'>) => admin.call('usage.get', { query });
    expect(brief((await get({ agent: billing.id })).totals)).toEqual({
      calls: 1,
      failed: 0,
      totalInput: 40,
      output: 5,
      cost: 0.002,
      unpriced: 0,
    });
    expect((await get({ actor: first.id })).totals.calls).toBe(3);
    expect((await get({ provider: 'fake', model: 'fake-1' })).totals.calls).toBe(4);
    expect((await get({ model: 'another' })).totals).toMatchObject({ calls: 0, first: null });
    expect((await get({ to: 1 })).totals.calls).toBe(0);
    expect((await get({ from: 1 })).totals.calls).toBe(4);

    const keys = async (by: 'agent' | 'actor' | 'account' | 'provider' | 'model' | 'day') =>
      (await get({ by })).groups?.map((group) => [group.key, group.totals.calls]);
    // What cost most first, and among those that cost the same, by what they are of.
    expect(await keys('agent')).toEqual(
      [
        [orders.id, 3],
        [billing.id, 1],
      ].toSorted((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
    );
    expect((await keys('actor'))?.toSorted((a, b) => Number(b[1]) - Number(a[1]))).toEqual([
      [first.id, 3],
      [second.id, 1],
    ]);
    expect(await keys('account')).toEqual([[account?.id, 4]]);
    expect(await keys('provider')).toEqual([['fake', 4]]);
    expect(await keys('model')).toEqual([['fake-1', 4]]);
    expect(await keys('day')).toEqual([[new Date().toISOString().slice(0, 10), 4]]);
    expect(await refusal(admin.call('usage.get', { query: { by: 'hour' as 'day' } }))).toEqual({
      code: 'invalid_request',
      status: 400,
    });
  });

  it('is told to a key of what the key reaches, and of nothing else', async () => {
    const { keyed, orders, billing, first, second } = await spent();
    const ofBilling = await keyed({
      scope: { type: 'agent', agent: billing.id },
      permissions: ['usage:read', 'actors:read'],
    });
    expect((await ofBilling.client.call('usage.get')).totals.calls).toBe(1);
    expect(
      (await ofBilling.client.call('usage.get', { query: { by: 'agent' } })).groups?.map(
        (group) => group.key,
      ),
    ).toEqual([billing.id]);
    // What it asks of another agent, or an actor of another's, is as if nothing was used.
    const elsewhere = await ofBilling.client.call('usage.get', {
      query: { agent: orders.id, by: 'actor' },
    });
    expect(elsewhere).toMatchObject({ totals: { calls: 0, cost: 0, first: null }, groups: [] });
    expect(
      (await ofBilling.client.call('usage.get', { query: { actor: first.id } })).totals.calls,
    ).toBe(0);
    expect(
      (await ofBilling.client.call('usage.get', { query: { actor: second.id } })).totals.calls,
    ).toBe(1);

    const without = await keyed({ scope: { type: 'engine' }, permissions: ['actors:read'] });
    expect(await refusal(without.client.call('usage.get'))).toEqual({
      code: 'forbidden',
      status: 403,
    });
  });

  it('of one actor is read by whoever may read the actor', async () => {
    const { admin, keyed, first, second } = await spent();
    const { totals, groups } = await admin.call('usage.actor', { params: { actor: first.id } });
    expect(brief(totals)).toEqual({
      calls: 3,
      failed: 1,
      totalInput: 80,
      output: 10,
      cost: 0.002,
      unpriced: 1,
    });
    expect(groups).toBeUndefined();

    const ofActor = await keyed({
      scope: { type: 'actor', actor: second.id },
      permissions: ['actors:read'],
    });
    expect(
      (await ofActor.client.call('usage.actor', { params: { actor: second.id } })).totals.calls,
    ).toBe(1);
    expect(
      await refusal(ofActor.client.call('usage.actor', { params: { actor: first.id } })),
    ).toEqual({ code: 'not_found', status: 404 });
  });

  it('stays when what used it is gone', async () => {
    const { admin, orders, first } = await spent();
    await admin.call('agents.delete', { params: { agent: orders.id } });
    expect((await admin.call('usage.get')).totals.calls).toBe(4);
    expect((await admin.call('usage.get', { query: { agent: orders.id } })).totals.calls).toBe(3);
    // The actor is gone, and so is the route that is of it.
    expect(await refusal(admin.call('usage.actor', { params: { actor: first.id } }))).toEqual({
      code: 'not_found',
      status: 404,
    });
  });
});
