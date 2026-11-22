import { describe, expect, it } from 'vitest';

import { PERMISSIONS, makeId } from '@acentric/protocol';
import type { ActorId, AgentId, Principal } from '@acentric/protocol';

import { Keys, SETTINGS_KEY, reaches } from '../src/keys.ts';
import type { NewKey } from '../src/keys.ts';
import { MemoryStore } from '../src/memory-store.ts';

const NOW = 1_795_305_600_000;
let made = 0;
const id = <K extends 'agent' | 'actor' | 'user' | 'session'>(kind: K) => {
  made += 1;
  return makeId(kind, { now: NOW, random: Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, made]) });
};
const orders = id('agent');
const billing = id('agent');
const desk = id('actor');
const elsewhere = id('actor');
const agents = new Map<ActorId, AgentId>([
  [desk, orders],
  [elsewhere, billing],
]);

const SETTINGS = 'a-key-an-operator-keeps-somewhere-safe';

function world(settingsKey: string | null = SETTINGS) {
  let now = NOW;
  const store = new MemoryStore();
  const keys = new Keys({
    store,
    ...(settingsKey === null ? {} : { settingsKey }),
    agentOf: async (actor) => agents.get(actor),
    clock: () => now,
  });
  const key = (given: Partial<NewKey> = {}): NewKey => ({
    label: 'for the support service',
    scope: { type: 'engine' },
    permissions: ['actors:read'],
    ...given,
  });
  return {
    store,
    keys,
    key,
    advance: (ms: number) => {
      now += ms;
    },
    /** Makes a key, and gives who a request with it is from. */
    made: async (by: Principal, given: Partial<NewKey> = {}) => {
      const { token, key: info } = await keys.create(by, key(given));
      return { token, info, principal: await keys.authenticate(token) };
    },
  };
}

describe('a request', () => {
  it('with the key an engine was started with may do everything', async () => {
    const { keys } = world();
    expect(await keys.authenticate(SETTINGS)).toEqual({
      type: 'key',
      key: SETTINGS_KEY,
      owner: null,
      scope: { type: 'engine' },
      permissions: [...PERMISSIONS],
      expiresAt: null,
    });
  });

  it('with a key that was made is from that key, with what it reaches and may do', async () => {
    const { keys, made: make } = world();
    const { token, info, principal } = await make(Keys.settings, {
      scope: { type: 'agent', agent: orders },
      permissions: ['actors:read', 'actors:send'],
    });
    expect(token).toMatch(/^ak_[0-9a-z]{26}_[A-Za-z0-9_-]{43}$/);
    expect(principal).toEqual({
      type: 'key',
      key: info.id,
      owner: null,
      scope: { type: 'agent', agent: orders },
      permissions: ['actors:read', 'actors:send'],
      expiresAt: null,
    });
    expect(await keys.get(Keys.settings, info.id)).toMatchObject({
      label: 'for the support service',
      createdBy: { type: 'key', id: SETTINGS_KEY },
      createdAt: NOW,
    });
  });

  it('with no key, one that is not known, or one that is nearly right is refused the same way', async () => {
    const { keys, made: make } = world();
    const { token } = await make(Keys.settings);
    const last = token.at(-1) === 'A' ? 'B' : 'A';
    const refused = [
      '',
      'not a key',
      'ak_00000000000000000000000000_' + 'a'.repeat(43),
      token.slice(0, -1) + last,
      'x'.repeat(40),
    ];
    for (const sent of refused) {
      await expect(keys.authenticate(sent), sent).rejects.toMatchObject({
        code: 'unauthenticated',
      });
    }
    await expect(keys.authenticate(undefined)).rejects.toThrow(/Authorization: Bearer/);
  });

  it('with a key that has expired, or was revoked, is refused', async () => {
    const { keys, made: make, advance } = world();
    const short = await make(Keys.settings, { expiresAt: NOW + 1000 });
    const revoked = await make(Keys.settings);
    advance(999);
    expect((await keys.authenticate(short.token)).key).toBe(short.info.id);
    advance(1);
    await expect(keys.authenticate(short.token)).rejects.toMatchObject({ code: 'unauthenticated' });
    await keys.revoke(Keys.settings, revoked.info.id);
    await expect(keys.authenticate(revoked.token)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('notes when its key was last used, once a minute at most', async () => {
    const { keys, store, made: make, advance } = world();
    const { token, info } = await make(Keys.settings);
    const used = async () => (await store.loadKey(info.id))?.key.lastUsedAt;
    expect(await used()).toBe(NOW);
    advance(30_000);
    await keys.authenticate(token);
    expect(await used()).toBe(NOW);
    advance(30_000);
    await keys.authenticate(token);
    expect(await used()).toBe(NOW + 60_000);
  });

  it('keeps nothing of a key but what tells it is the one', async () => {
    const { store, made: make } = world();
    const { token } = await make(Keys.settings);
    const secret = token.split('_')[2] as string;
    expect(JSON.stringify(await store.listKeys())).not.toContain(secret);
  });
});

describe('an engine nothing can call yet', () => {
  it('makes one key that may do everything, once, and none when it was started with one', async () => {
    const fresh = world(null);
    const first = await fresh.keys.first();
    expect(first).toMatch(/^ak_/);
    expect(await fresh.keys.authenticate(first)).toMatchObject({
      scope: { type: 'engine' },
      permissions: [...PERMISSIONS],
    });
    expect(await fresh.keys.first()).toBeUndefined();
    expect(await world().keys.first()).toBeUndefined();
  });

  it('is not started with a key too short to be one', () => {
    expect(() => world('short')).toThrow(/24 characters/);
  });
});

describe('a key that makes keys', () => {
  it('makes none that holds what it does not hold, or what its scope cannot', async () => {
    const { keys, key, made: make } = world();
    const { principal } = await make(Keys.settings, {
      scope: { type: 'agent', agent: orders },
      permissions: ['keys:manage', 'actors:read'],
    });
    await expect(
      keys.create(principal, key({ scope: principal.scope, permissions: ['actors:send'] })),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      keys.create(
        Keys.settings,
        key({ scope: { type: 'actor', actor: desk }, permissions: ['agents:deploy'] }),
      ),
    ).rejects.toThrow(/A key for one actor cannot hold agents:deploy/);
    await expect(keys.create(Keys.settings, key({ permissions: [] }))).rejects.toMatchObject({
      code: 'invalid_request',
    });
    // One that may not make keys makes none.
    const reader = await make(Keys.settings, { permissions: ['actors:read'] });
    await expect(keys.create(reader.principal, key())).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('makes none that reaches further than it does', async () => {
    const { keys, key, made: make } = world();
    const { principal } = await make(Keys.settings, {
      scope: { type: 'agent', agent: orders },
      permissions: ['keys:manage', 'actors:read'],
    });
    const scoped = (scope: NewKey['scope']) =>
      keys.create(principal, key({ scope, permissions: ['actors:read'] }));

    // Its own agent, and an actor of its own agent.
    expect((await scoped({ type: 'agent', agent: orders })).key.scope).toEqual(principal.scope);
    expect((await scoped({ type: 'actor', actor: desk })).key.owner).toBeNull();
    for (const beyond of [
      { type: 'engine' },
      { type: 'agent', agent: billing },
      { type: 'actor', actor: elsewhere },
      { type: 'actor', actor: id('actor') },
    ] as const) {
      await expect(scoped(beyond), JSON.stringify(beyond)).rejects.toMatchObject({
        code: 'forbidden',
      });
    }
  });

  it('makes none that works for longer than it does', async () => {
    const { keys, key, made: make } = world();
    const { principal } = await make(Keys.settings, {
      permissions: ['keys:manage', 'actors:read'],
      expiresAt: NOW + 10_000,
    });
    await expect(keys.create(principal, key({ expiresAt: NOW + 20_000 }))).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(keys.create(principal, key({ expiresAt: NOW }))).rejects.toMatchObject({
      code: 'invalid_request',
    });
    // One that says nothing of when it expires does so with its maker.
    expect((await keys.create(principal, key())).key.expiresAt).toBe(NOW + 10_000);
    expect((await keys.create(principal, key({ expiresAt: NOW + 5000 }))).key.expiresAt).toBe(
      NOW + 5000,
    );
  });

  it('sees, and revokes, the keys no wider than itself, and to it no other is there', async () => {
    const { keys, made: make } = world();
    const manage = ['keys:manage', 'actors:read'] as const;
    const whole = await make(Keys.settings, { permissions: manage });
    const ofOrders = await make(Keys.settings, {
      scope: { type: 'agent', agent: orders },
      permissions: manage,
    });
    const ofDesk = await make(Keys.settings, { scope: { type: 'actor', actor: desk } });
    const ofBilling = await make(Keys.settings, { scope: { type: 'agent', agent: billing } });
    const ids = async (by: Principal) => (await keys.list(by)).map((key) => key.id);

    expect(await ids(whole.principal)).toEqual(
      [whole, ofOrders, ofDesk, ofBilling].map((one) => one.info.id),
    );
    expect(await ids(ofOrders.principal)).toEqual([ofOrders.info.id, ofDesk.info.id]);
    await expect(keys.get(ofOrders.principal, ofBilling.info.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(keys.revoke(ofOrders.principal, whole.info.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    await keys.revoke(ofOrders.principal, ofDesk.info.id);
    expect(await ids(whole.principal)).not.toContain(ofDesk.info.id);
  });

  it('is revoked with every key it made, however far down, and no other', async () => {
    const { keys, made: make } = world();
    const manage = ['keys:manage', 'actors:read'] as const;
    const parent = await make(Keys.settings, { permissions: manage });
    const child = await make(parent.principal, { permissions: manage });
    const grandchild = await make(child.principal);
    const sibling = await make(Keys.settings);

    await keys.revoke(Keys.settings, parent.info.id);
    for (const gone of [parent, child, grandchild]) {
      await expect(keys.authenticate(gone.token)).rejects.toMatchObject({
        code: 'unauthenticated',
      });
    }
    expect((await keys.authenticate(sibling.token)).key).toBe(sibling.info.id);
  });
});

describe('a person', () => {
  const person: Principal = {
    type: 'user',
    user: id('user'),
    email: 'ada@example.com',
    role: 'member',
    permissions: ['keys:manage', 'actors:read'],
    session: id('session'),
  };

  it('makes a key that is theirs, or a service’s that is nobody’s', async () => {
    const { keys, key } = world();
    const mine = await keys.create(person, key());
    expect(mine.key).toMatchObject({
      owner: person.user,
      createdBy: { type: 'user', id: person.user },
    });
    expect((await keys.create(person, key({ service: true }))).key.owner).toBeNull();
    await expect(
      keys.create(person, key({ permissions: ['agents:deploy'] })),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('what a key reaches', () => {
  it('is everything, one agent and its actors, or one actor and nothing of its agent besides', () => {
    expect(reaches({ type: 'engine' }, { agent: orders })).toBe(true);
    expect(reaches({ type: 'agent', agent: orders }, { agent: orders, actor: desk })).toBe(true);
    expect(reaches({ type: 'agent', agent: orders }, { agent: billing })).toBe(false);
    expect(reaches({ type: 'actor', actor: desk }, { agent: orders, actor: desk })).toBe(true);
    expect(reaches({ type: 'actor', actor: desk }, { agent: orders })).toBe(false);
    expect(reaches({ type: 'actor', actor: desk }, { agent: orders, actor: elsewhere })).toBe(
      false,
    );
  });
});
