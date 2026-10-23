// What every store must do, for any backend: run `describeStore` with a
// way to open the same store more than once.

import type { LogEntry } from '@acentric/types';
import { afterEach, describe, expect, it } from 'vitest';

import { StoreError } from '../dist/index.js';
import type { Bundle, InstanceRecord, Store, StoredEffect } from '../dist/index.js';

/** A place a store lives: each `open` opens the same store again. */
export type StoreLocation = { open(): Promise<Store>; remove(): Promise<void> };

const bundle: Bundle = {
  name: 'echo',
  version: '1',
  hash: 'h1',
  agent: 'export default {}',
  handlers: 'export default {}',
  kinds: { echo: { mode: 'reissue' }, send: { mode: 'once', timeoutMs: 50, maxAttempts: 2 } },
};

const instance = (id = 'i1'): InstanceRecord => ({
  id,
  agent: { name: 'echo', version: '1' },
  config: { a: 1 },
  snapshot: { n: 0 },
  nextSeq: 1,
  fault: null,
  createHash: 'c1',
  createdAt: 1000,
});

const entry = (seq: number, kind = 'note'): LogEntry => ({
  seq,
  at: 1000 + seq,
  kind,
  body: { seq },
});
const effect = (key: string, kind = 'echo'): StoredEffect => ({
  request: { key, kind, args: { key } },
  mode: 'reissue',
  attempt: 1,
});

async function rejects(promise: Promise<unknown>, code: StoreError['code']): Promise<void> {
  const error: unknown = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(StoreError);
  expect(error instanceof StoreError ? error.code : null).toBe(code);
}

export function describeStore(name: string, location: () => Promise<StoreLocation>): void {
  describe(`${name} store`, () => {
    let place: StoreLocation;
    const opened: Store[] = [];
    const open = async (): Promise<Store> => {
      place ??= await location();
      const store = await place.open();
      opened.push(store);
      return store;
    };
    /** Closes `store` and opens it again, as after a restart. */
    const reopen = async (store: Store): Promise<Store> => {
      await store.close();
      return open();
    };

    afterEach(async () => {
      await Promise.all(opened.splice(0).map((store) => store.close()));
      await place.remove();
      // A fresh location for the next test.
      place = await location();
    });

    it('is taken by one runner at a time', async () => {
      const store = await open();
      await rejects(place.open(), 'locked');
      const again = await reopen(store);
      expect(await again.list()).toEqual([]);
    });

    it('keeps bundles, refusing different code under a deployed version', async () => {
      const store = await open();
      expect(await store.putBundle(bundle)).toBe('stored');
      expect(await store.putBundle(bundle)).toBe('exists');
      await rejects(store.putBundle({ ...bundle, hash: 'h2' }), 'bundle_conflict');
      expect(await store.putBundle({ ...bundle, version: '2', hash: 'h2' })).toBe('stored');
      const again = await reopen(store);
      expect(await again.getBundle({ name: 'echo', version: '1' })).toEqual(bundle);
      expect(await again.getBundle({ name: 'echo', version: '3' })).toBeNull();
      expect(await again.listBundles()).toEqual([
        { name: 'echo', version: '1', hash: 'h1', instances: 0 },
        { name: 'echo', version: '2', hash: 'h2', instances: 0 },
      ]);
    });

    it('creates an instance with its init step, once', async () => {
      const store = await open();
      await store.create(instance(), {
        append: [entry(1), entry(2)],
        started: [effect('a')],
        request: { id: 'create', hash: 'c1', answer: { accepted: true } },
      });
      await rejects(store.create(instance(), { append: [], started: [] }), 'instance_exists');
      const again = await reopen(store);
      expect(await again.load('i1')).toEqual({ ...instance(), nextSeq: 3, running: [effect('a')] });
      expect(await again.readLog('i1')).toEqual([entry(1), entry(2)]);
      expect(await again.findRequest('i1', 'create')).toEqual({
        id: 'create',
        hash: 'c1',
        answer: { accepted: true },
      });
      expect(await again.load('nope')).toBeNull();
    });

    it('saves a step whole', async () => {
      const store = await open();
      await store.create(instance(), { append: [entry(1)], started: [effect('a'), effect('b')] });
      const ord = await store.putResult('i1', 'a', { ok: 5 });
      await store.commit('i1', {
        expectedSeq: 2,
        snapshot: { n: 1 },
        config: { a: 2 },
        append: [entry(2), entry(3)],
        started: [effect('c')],
        finished: ['a'],
        aborted: ['b'],
        consumed: ord,
        request: { id: 'in-1', hash: 'x', answer: { accepted: true } },
      });
      const again = await reopen(store);
      const loaded = await again.load('i1');
      expect(loaded).toMatchObject({ snapshot: { n: 1 }, config: { a: 2 }, nextSeq: 4 });
      expect(loaded?.running).toEqual([
        { ...effect('b'), request: { ...effect('b').request, abort: true } },
        effect('c'),
      ]);
      expect(await again.inbox('i1')).toEqual([]);
      expect(await again.findFinished('i1', ['a', 'b', 'c', 'z'])).toEqual(new Set(['a']));
      expect(await again.findRequest('i1', 'in-1')).toMatchObject({ hash: 'x' });
    });

    it('applies nothing of a step that fails', async () => {
      const store = await open();
      await store.create(instance(), { append: [entry(1)], started: [effect('a')] });
      // The last change is invalid: finishing a key that is not running.
      await rejects(
        store.commit('i1', {
          expectedSeq: 2,
          snapshot: { n: 9 },
          append: [entry(2)],
          started: [effect('c')],
          finished: ['a', 'not-running'],
          aborted: [],
        }),
        'invalid',
      );
      const again = await reopen(store);
      expect(await again.load('i1')).toEqual({ ...instance(), nextSeq: 2, running: [effect('a')] });
      expect(await again.readLog('i1')).toEqual([entry(1)]);
    });

    it('refuses a stale step, and entries out of sequence', async () => {
      const store = await open();
      await store.create(instance(), { append: [entry(1)], started: [] });
      const step = { snapshot: {}, started: [], finished: [], aborted: [] };
      await rejects(
        store.commit('i1', { ...step, expectedSeq: 1, append: [entry(1)] }),
        'stale_commit',
      );
      await rejects(store.commit('i1', { ...step, expectedSeq: 2, append: [entry(3)] }), 'invalid');
      await rejects(
        store.commit('i1', { ...step, expectedSeq: 2, append: [entry(2), entry(4)] }),
        'invalid',
      );
      await rejects(store.commit('nope', { ...step, expectedSeq: 1, append: [] }), 'no_instance');
      await store.commit('i1', { ...step, expectedSeq: 2, append: [entry(2)] });
      expect((await store.readLog('i1')).map((e) => e.seq)).toEqual([1, 2]);
    });

    it('keeps the inbox in order across a restart', async () => {
      const store = await open();
      await store.create(instance(), { append: [], started: [effect('a'), effect('b')] });
      await store.putResult('i1', 'b', { ok: 'b' });
      await store.putResult('i1', 'a', { interrupted: true });
      expect(await store.pending()).toEqual(['i1']);
      const again = await reopen(store);
      const inbox = await again.inbox('i1');
      expect(inbox.map(({ key, outcome }) => ({ key, outcome }))).toEqual([
        { key: 'b', outcome: { ok: 'b' } },
        { key: 'a', outcome: { interrupted: true } },
      ]);
      expect(inbox[0]?.ord).toBeLessThan(inbox[1]?.ord ?? 0);
    });

    it('reads log ranges', async () => {
      const store = await open();
      await store.create(instance(), {
        append: [entry(1, 'a'), entry(2, 'b'), entry(3, 'a'), entry(4, 'b'), entry(5, 'a')],
        started: [],
      });
      const seqs = async (range: Parameters<Store['readLog']>[1]): Promise<number[]> =>
        (await store.readLog('i1', range)).map((e) => e.seq);
      expect(await seqs({ after: 2 })).toEqual([3, 4, 5]);
      expect(await seqs({ before: 3 })).toEqual([1, 2]);
      expect(await seqs({ kinds: ['b'] })).toEqual([2, 4]);
      expect(await seqs({ after: 1, limit: 2 })).toEqual([2, 3]);
      expect(await seqs({ kinds: [] })).toEqual([]);
    });

    it('records attempts, faults and answers given without a step', async () => {
      const store = await open();
      await store.create(instance(), { append: [], started: [effect('a')] });
      await store.recordAttempt('i1', 'a', 2);
      await store.setFault('i1', 'broken');
      await store.putRequest('i1', { id: 'r', hash: 'h', answer: { rejected: 'no' } });
      const again = await reopen(store);
      expect(await again.load('i1')).toMatchObject({ fault: 'broken', running: [{ attempt: 2 }] });
      expect(await again.findRequest('i1', 'r')).toEqual({
        id: 'r',
        hash: 'h',
        answer: { rejected: 'no' },
      });
      await again.commit('i1', {
        expectedSeq: 1,
        snapshot: {},
        agent: { name: 'echo', version: '2' },
        clearFault: true,
        append: [],
        started: [],
        finished: [],
        aborted: [],
      });
      expect(await again.load('i1')).toMatchObject({ fault: null, agent: { version: '2' } });
    });

    it('lists and deletes instances', async () => {
      const store = await open();
      await store.create(instance('i1'), { append: [], started: [effect('a')] });
      await store.create(instance('i2'), { append: [], started: [] });
      await store.setFault('i2', 'broken');
      expect((await store.list()).map((i) => [i.id, i.running, i.fault])).toEqual([
        ['i1', 1, null],
        ['i2', 0, 'broken'],
      ]);
      expect((await store.list({ faulted: true })).map((i) => i.id)).toEqual(['i2']);
      expect((await store.list({ after: 'i1' })).map((i) => i.id)).toEqual(['i2']);
      expect((await store.list({ agent: 'other' })).map((i) => i.id)).toEqual([]);
      await store.putResult('i1', 'a', { ok: 1 });
      await store.delete('i1');
      expect(await store.load('i1')).toBeNull();
      expect(await store.pending()).toEqual([]);
      expect((await store.list()).map((i) => i.id)).toEqual(['i2']);
    });
  });
}
