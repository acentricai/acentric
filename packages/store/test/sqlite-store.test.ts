import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { says } from '@acentric/ai/testing';
import { makeId } from '@acentric/protocol';
import type { Actor } from '@acentric/protocol';

import { engineSuite } from '../../core/test/engine-suite.ts';
import { storeSuite } from '../../core/test/store-suite.ts';
import { upgradeSuite } from '../../core/test/upgrade-suite.ts';
import { world } from '../../core/test/world.ts';
import { SCHEMA_VERSION, SqliteStore } from '../src/index.ts';
import { databases } from './temp.ts';

const database = databases();

storeSuite('on SQLite', () => SqliteStore.open(database()));
storeSuite('on SQLite, every write a transaction of its own', () =>
  SqliteStore.open(database(), { groupCommit: false }),
);
storeSuite('on SQLite, in memory', () => SqliteStore.open(':memory:'));
engineSuite('on SQLite', () => SqliteStore.open(database()));
upgradeSuite('on SQLite', () => SqliteStore.open(database()));

const NOW = 1_795_305_600_000;
let made = 0;
const actorOf = (): Actor => {
  made += 1;
  const random = (fill: number) =>
    Uint8Array.from([0, 0, 0, 0, 0, 0, 0, fill, made >> 8, made & 255]);
  return {
    id: makeId('actor', { now: NOW, random: random(1) }),
    name: null,
    externalId: null,
    agent: makeId('agent', { now: NOW, random: random(2) }),
    deployment: { id: makeId('deployment', { now: NOW, random: random(3) }), version: 1 },
    pinned: false,
    behind: null,
    modelId: 'fake-1',
    reasoning: 'medium',
    configuration: null,
    status: 'idle',
    lastTurn: null,
    pendingInputs: 0,
    createdAt: NOW,
    archivedAt: null,
  };
};

const change = (seq: number) => ({
  at: NOW,
  status: 'working' as const,
  lastTurn: null,
  archivedAt: null,
  turn: { phase: 'model' as const, startSeq: 1, attempt: 1, cutOffs: 0, retryAt: null },
  append: [
    {
      seq,
      message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] },
      createdAt: NOW,
    },
  ],
  deliver: [],
  leaveOutFrom: null,
  set: null,
  sent: null,
  usage: null,
});

describe('the store on SQLite', () => {
  it('has what it was given after it is closed and opened again', async () => {
    const path = database();
    const first = await SqliteStore.open(path);
    const actor = actorOf();
    await first.createActor(actor);
    await first.commit(actor.id, 0, change(1));
    await first.close();

    const second = await SqliteStore.open(path);
    expect(await second.loadActor(actor.id)).toMatchObject({ epoch: 1, nextSeq: 2 });
    expect(await second.conversation(actor.id)).toHaveLength(1);
    expect(await second.unfinished()).toEqual([actor.id]);
    await second.close();
  });

  it('is a conversation an engine goes on with after a restart of everything', async () => {
    const path = database();
    const before = world({ store: await SqliteStore.open(path) });
    const one = before.engine([says('Hello.')]);
    const actor = await one.createActor();
    await one.say(actor.id, 'Hello?');
    await one.it.settled(actor.id);
    await one.it.close();
    await before.store.close();

    const after = world({ store: await SqliteStore.open(path) });
    const two = after.engine([says('Still here.')]);
    await two.say(actor.id, 'Are you still there?');
    await two.it.settled(actor.id);

    expect(await after.roles(actor.id)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(two.steps[0]?.messages).toHaveLength(3);
    await after.store.close();
  });

  it('stores writes that come together in one transaction, and so waits for the disk once', async () => {
    const store = await SqliteStore.open(database());
    const actors = Array.from({ length: 50 }, actorOf);
    await Promise.all(actors.map((actor) => store.createActor(actor)));
    const created = await store.stats();

    await Promise.all(actors.map((actor) => store.commit(actor.id, 0, change(1))));
    const committed = await store.stats();
    await store.close();

    expect(committed.writes - created.writes).toBe(50);
    // They were sent in one turn of the loop, and the thread took them together.
    expect(committed.transactions - created.transactions).toBeLessThan(10);
  });

  it('stores each write alone when it is told to, for the comparison', async () => {
    const store = await SqliteStore.open(database(), { groupCommit: false });
    const actors = Array.from({ length: 20 }, actorOf);
    await Promise.all(actors.map((actor) => store.createActor(actor)));
    expect(await store.stats()).toEqual({ writes: 20, transactions: 20 });
    await store.close();
  });

  it('keeps a write that is refused from taking the others of its transaction with it', async () => {
    const store = await SqliteStore.open(database());
    const [good, bad] = [actorOf(), actorOf()];
    await Promise.all([store.createActor(good), store.createActor(bad)]);

    const tried = await Promise.allSettled([
      store.commit(good.id, 0, change(1)),
      // An epoch that never was: refused.
      store.commit(bad.id, 7, change(1)),
      store.commit(good.id, 1, change(2)),
    ]);
    expect(tried.map((one) => one.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(await store.conversation(good.id)).toHaveLength(2);
    expect(await store.conversation(bad.id)).toEqual([]);
    await store.close();
  });

  it('is at this version, and refuses a database made by a newer one', async () => {
    const path = database();
    await (await SqliteStore.open(path)).close();
    const db = new DatabaseSync(path);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION });
    db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION + 1)}`);
    db.close();

    await expect(SqliteStore.open(path)).rejects.toThrow(/made by a newer one/);
  });

  it('refuses everything once it is closed', async () => {
    const store = await SqliteStore.open(database());
    await store.close();
    await expect(store.unfinished()).rejects.toThrow(/closed/);
  });
});
