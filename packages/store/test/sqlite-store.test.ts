import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { says } from '@acentric/ai/testing';
import { makeId } from '@acentric/protocol';
import type { Actor } from '@acentric/protocol';

import { bashSuite } from '../../core/test/bash-suite.ts';
import { codeSuite } from '../../core/test/code-suite.ts';
import { compactionSuite } from '../../core/test/compaction-suite.ts';
import { engineSuite } from '../../core/test/engine-suite.ts';
import { machinesSuite } from '../../core/test/machines-suite.ts';
import { sandboxesSuite } from '../../core/test/sandboxes-suite.ts';
import { scheduleSuite } from '../../core/test/schedule-suite.ts';
import { subagentsSuite } from '../../core/test/subagents-suite.ts';
import { storeSuite } from '../../core/test/store-suite.ts';
import { tasksSuite } from '../../core/test/tasks-suite.ts';
import { upgradeSuite } from '../../core/test/upgrade-suite.ts';
import { world } from '../../core/test/world.ts';
import { SCHEMA_VERSION, SqliteStore } from '../src/index.ts';
import { MIGRATIONS } from '../src/migrations.ts';
import { databases } from './temp.ts';

const database = databases();

storeSuite('on SQLite', () => SqliteStore.open(database()));
storeSuite('on SQLite, every write a transaction of its own', () =>
  SqliteStore.open(database(), { groupCommit: false }),
);
storeSuite('on SQLite, in memory', () => SqliteStore.open(':memory:'));
engineSuite('on SQLite', () => SqliteStore.open(database()));
upgradeSuite('on SQLite', () => SqliteStore.open(database()));
tasksSuite('on SQLite', () => SqliteStore.open(database()));
machinesSuite('on SQLite', () => SqliteStore.open(database()));
bashSuite('on SQLite', () => SqliteStore.open(database()));
sandboxesSuite('on SQLite', () => SqliteStore.open(database()));
scheduleSuite('on SQLite', () => SqliteStore.open(database()));
subagentsSuite('on SQLite', () => SqliteStore.open(database()));
compactionSuite('on SQLite', () => SqliteStore.open(database()));
codeSuite('on SQLite', () => SqliteStore.open(database()));

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
    account: null,
    modelId: 'fake-1',
    reasoning: 'medium',
    configuration: null,
    machine: null,
    parent: null,
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

  it('stores the writes asked for before it was closed, when they come with the close', async () => {
    // One thread, which reads as well, as a database in memory has: the close goes at once,
    // with the writes before it.
    const store = await SqliteStore.open(':memory:');
    // Enough that the thread is still at the first when the rest and the close come.
    const actors = Array.from({ length: 2_000 }, actorOf);
    // Not waited for: the close is sent with them, and is taken with them.
    const writes = actors.map((actor) => store.createActor(actor));
    await store.close();
    const settled = await Promise.allSettled(writes);
    expect(settled.filter((one) => one.status === 'rejected')).toEqual([]);
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

  it('gives each actor of a database from before actors had accounts what its calls were made with', async () => {
    const path = database();
    const db = new DatabaseSync(path);
    for (const migration of MIGRATIONS.slice(0, 5)) db.exec(migration);
    db.exec('PRAGMA user_version = 5');
    const account = (id: string, provider: string, isDefault: boolean) =>
      db
        .prepare('INSERT INTO accounts (id, name, account, sealed) VALUES (?, ?, ?, ?)')
        .run(id, id, JSON.stringify({ id, provider, name: id, default: isDefault }), 'sealed');
    account('acc_main', 'fake', true);
    account('acc_own', 'fake', false);
    const agent = (id: string, provider: string, given: string | null) =>
      db
        .prepare(
          `INSERT INTO agents (id, name, provider, active_id, active_version, latest_id,
             latest_version, account_id, created_at) VALUES (?, ?, ?, 'dep_1', 1, 'dep_1', 1, ?, 1)`,
        )
        .run(id, id, provider, given);
    agent('agt_given', 'fake', 'acc_own');
    agent('agt_default', 'fake', null);
    agent('agt_none', 'other', null);
    const actor = (id: string, of: string) =>
      db
        .prepare(
          `INSERT INTO actors (id, agent_id, deployment_id, deployment_version, pinned, model,
             reasoning, reasoning_from, status, turn, owed, epoch, next_seq, created_at)
           VALUES (?, ?, 'dep_1', 1, 0, 'fake-1', 'low', 1, 'idle', '{}', 0, 0, 1, 1)`,
        )
        .run(id, of);
    actor('act_given', 'agt_given');
    actor('act_default', 'agt_default');
    actor('act_none', 'agt_none');
    db.close();

    await (await SqliteStore.open(path)).close();
    const after = new DatabaseSync(path);
    expect(after.prepare('SELECT id, account_id FROM actors ORDER BY id').all()).toEqual([
      // Its agent's account, the account its provider's default, and none where there was none.
      { id: 'act_default', account_id: 'acc_main' },
      { id: 'act_given', account_id: 'acc_own' },
      { id: 'act_none', account_id: null },
    ]);
    // An agent has no account of its own any more.
    const columns = after.prepare('PRAGMA table_info(agents)').all() as { name: string }[];
    expect(columns.map((column) => column.name)).not.toContain('account_id');
    after.close();
  });

  it('refuses everything once it is closed', async () => {
    const store = await SqliteStore.open(database());
    await store.close();
    await expect(store.unfinished()).rejects.toThrow(/closed/);
  });
});

describe('a SQLite store that removes what it had', () => {
  it('was made to give the space back to the disk, and does when it is asked', async () => {
    const path = database();
    const store = await SqliteStore.open(path);
    try {
      const actor = actorOf();
      for (let n = 0; n < 2000; n += 1) {
        await store.recordUsage({
          at: NOW + n,
          actor: actor.id,
          agent: actor.agent,
          version: 1,
          account: null,
          provider: 'fake',
          model: `fake-${'x'.repeat(400)}-${String(n)}`,
          usage: null,
          failure: null,
          durationMs: 1,
        });
      }
      expect(await store.pruneUsage(NOW + 2000, 5000)).toBe(2000);
      expect(await store.freePages()).toBeGreaterThan(100_000);
      // And has nothing more to give back.
      expect(await store.freePages()).toBe(0);
    } finally {
      await store.close();
    }
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      // 2: incremental.
      expect(db.prepare('PRAGMA auto_vacuum').get()).toEqual({ auto_vacuum: 2 });
    } finally {
      db.close();
    }
  });
});
