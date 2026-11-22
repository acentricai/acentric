import { describe, expect, it } from 'vitest';

import { makeId } from '@acentric/protocol';

import { MemoryStore } from '../src/memory-store.ts';
import { Secrets, secretKeyOf } from '../src/secrets.ts';
import type { SecretKeys } from '../src/secrets.ts';

const NOW = 1_795_305_600_000;
const agent = makeId('agent', { now: NOW, random: new Uint8Array(10).fill(1) });
const other = makeId('agent', { now: NOW, random: new Uint8Array(10).fill(2) });
const key = (fill: number) => new Uint8Array(32).fill(fill);
const one: SecretKeys = { current: 'k1', keys: { k1: key(1) } };

describe('an agent’s secrets', () => {
  it('are read back by the agent they were set for, by name', async () => {
    const store = new MemoryStore();
    const secrets = new Secrets({ store, keys: one, clock: () => NOW });
    await secrets.set(agent, 'ORDERS_API_KEY', 'k-1');
    await secrets.set(agent, 'BILLING_KEY', 'b-1');
    await secrets.set(other, 'ORDERS_API_KEY', 'k-2');

    expect(await secrets.get(agent, 'ORDERS_API_KEY')).toBe('k-1');
    expect(await secrets.get(other, 'ORDERS_API_KEY')).toBe('k-2');
    expect(await secrets.get(agent, 'NONE')).toBeUndefined();
    expect(await secrets.names(agent)).toEqual(['BILLING_KEY', 'ORDERS_API_KEY']);

    await secrets.set(agent, 'ORDERS_API_KEY', 'k-3');
    expect(await secrets.get(agent, 'ORDERS_API_KEY')).toBe('k-3');
    expect(await secrets.delete(agent, 'BILLING_KEY')).toBe(true);
    expect(await secrets.delete(agent, 'BILLING_KEY')).toBe(false);
    expect(await secrets.names(agent)).toEqual(['ORDERS_API_KEY']);
  });

  it('are stored sealed: the store has no value, and says which key sealed each', async () => {
    const store = new MemoryStore();
    const secrets = new Secrets({ store, keys: one, clock: () => NOW });
    await secrets.set(agent, 'ORDERS_API_KEY', 'a-value-nobody-else-has');
    const stored = await store.getSecret(agent, 'ORDERS_API_KEY');
    expect(stored).toMatchObject({ agent, name: 'ORDERS_API_KEY', updatedAt: NOW });
    expect(stored?.sealed).toMatch(/^v1\.k1\.[A-Za-z0-9+/=]+$/);
    expect(JSON.stringify(stored)).not.toContain('a-value-nobody-else-has');
    // The same value is sealed differently each time.
    await secrets.set(agent, 'AGAIN', 'a-value-nobody-else-has');
    expect((await store.getSecret(agent, 'AGAIN'))?.sealed.split('.')[2]).not.toBe(
      stored?.sealed.split('.')[2],
    );
  });

  it('do not open as another’s: a sealed value moved to another name or agent is refused', async () => {
    const store = new MemoryStore();
    const secrets = new Secrets({ store, keys: one });
    await secrets.set(agent, 'ORDERS_API_KEY', 'k-1');
    const stored = await store.getSecret(agent, 'ORDERS_API_KEY');
    if (stored === undefined) throw new Error('unreachable');
    await store.setSecret({ ...stored, name: 'BILLING_KEY' });
    await store.setSecret({ ...stored, agent: other });
    await expect(secrets.get(agent, 'BILLING_KEY')).rejects.toThrow(/does not open/);
    await expect(secrets.get(other, 'ORDERS_API_KEY')).rejects.toThrow(/does not open/);
  });

  it('are refused a name that is not one', async () => {
    const secrets = new Secrets({ store: new MemoryStore(), keys: one });
    for (const name of ['', '1KEY', 'my-key', 'a b']) {
      await expect(secrets.set(agent, name, 'x'), name).rejects.toMatchObject({
        code: 'invalid_request',
      });
    }
  });

  it('are not kept at all by an engine that was given no key', async () => {
    const store = new MemoryStore();
    const secrets = new Secrets({ store });
    await expect(secrets.set(agent, 'ORDERS_API_KEY', 'k-1')).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(await store.allSecrets()).toEqual([]);
    // What is not set is still not set, and the names are no secret.
    expect(await secrets.get(agent, 'ORDERS_API_KEY')).toBeUndefined();
    expect(await secrets.names(agent)).toEqual([]);
  });
});

describe('the key secrets are sealed with', () => {
  it('is changed without losing a secret: the old key opens what it sealed until all is sealed again', async () => {
    const store = new MemoryStore();
    const before = new Secrets({ store, keys: one });
    await before.set(agent, 'ORDERS_API_KEY', 'k-1');
    await before.set(other, 'BILLING_KEY', 'b-1');

    const both: SecretKeys = { current: 'k2', keys: { k1: key(1), k2: key(2) } };
    const during = new Secrets({ store, keys: both });
    expect(await during.get(agent, 'ORDERS_API_KEY')).toBe('k-1');
    await during.set(agent, 'NEW', 'n-1');
    expect((await store.getSecret(agent, 'NEW'))?.sealed).toMatch(/^v1\.k2\./);

    // Two were sealed with the old key, and one with the new already.
    expect(await during.reseal()).toBe(2);
    expect(await during.reseal()).toBe(0);
    const after = new Secrets({ store, keys: { current: 'k2', keys: { k2: key(2) } } });
    expect(await after.get(agent, 'ORDERS_API_KEY')).toBe('k-1');
    expect(await after.get(other, 'BILLING_KEY')).toBe('b-1');
    expect(await after.get(agent, 'NEW')).toBe('n-1');
  });

  it('says which key is missing when a secret was sealed with one it was not given', async () => {
    const store = new MemoryStore();
    await new Secrets({ store, keys: one }).set(agent, 'ORDERS_API_KEY', 'k-1');
    const without = new Secrets({ store, keys: { current: 'k2', keys: { k2: key(2) } } });
    await expect(without.get(agent, 'ORDERS_API_KEY')).rejects.toThrow(/the key k1/);
    // The same ID with another key in it opens nothing.
    const wrong = new Secrets({ store, keys: { current: 'k1', keys: { k1: key(9) } } });
    await expect(wrong.get(agent, 'ORDERS_API_KEY')).rejects.toThrow(/does not open/);
  });

  it('is 32 bytes, given as hex or as base64, and anything else is refused when the engine starts', () => {
    expect(secretKeyOf('ab'.repeat(32))).toHaveLength(32);
    expect(secretKeyOf(Buffer.from(key(3)).toString('base64'))).toEqual(Buffer.from(key(3)));
    expect(() => secretKeyOf('too-short')).toThrow(/32 bytes/);
    const store = new MemoryStore();
    expect(
      () => new Secrets({ store, keys: { current: 'k1', keys: { k1: key(1).slice(1) } } }),
    ).toThrow(/32 bytes/);
    expect(() => new Secrets({ store, keys: { current: 'k9', keys: { k1: key(1) } } })).toThrow(
      /not among/,
    );
    expect(() => new Secrets({ store, keys: { current: 'a.b', keys: { 'a.b': key(1) } } })).toThrow(
      /not the ID/,
    );
  });
});
