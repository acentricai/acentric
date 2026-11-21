// What every store must do, whatever it is made of. The store in memory is held to this here,
// and the store on SQLite in its own package, by the same tests.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeId } from '@acentric/protocol';
import type { Actor, AgentId, ConversationEntry, Input } from '@acentric/protocol';

import type { Change } from '../src/state.ts';
import type { Store } from '../src/store.ts';

const NOW = 1_795_305_600_000;

export function storeSuite(name: string, open: () => Promise<Store>): void {
  describe(`a store: ${name}`, () => {
    let store: Store;
    let made = 0;
    const random = () => {
      made += 1;
      return Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, made >> 8, made & 255]);
    };
    const agentId = (): AgentId => makeId('agent', { now: NOW, random: random() });

    const actorOf = (agent: AgentId, more: Partial<Actor> = {}): Actor => ({
      id: makeId('actor', { now: NOW, random: random() }),
      name: null,
      externalId: null,
      agent,
      deployment: { id: makeId('deployment', { now: NOW, random: random() }), version: 1 },
      model: 'fake-1',
      reasoning: 'medium',
      configuration: { region: 'eu' },
      status: 'idle',
      lastTurn: null,
      pendingInputs: 0,
      createdAt: NOW,
      archivedAt: null,
      ...more,
    });

    const inputOf = (actor: Actor, text: string, externalId: string | null = null): Input => ({
      id: makeId('input', { now: NOW, random: random() }),
      actor: actor.id,
      type: 'message',
      externalId,
      message: { role: 'user', content: [{ type: 'text', text }] },
      receivedAt: NOW,
      deliveredAt: null,
    });

    const said = (seq: number, text: string): ConversationEntry => ({
      seq,
      message: { role: 'user', content: [{ type: 'text', text }] },
      createdAt: NOW,
    });

    const change = (more: Partial<Change> = {}): Change => ({
      at: NOW + 1,
      status: 'working',
      lastTurn: null,
      archivedAt: null,
      turn: { phase: 'model', startSeq: 1, attempt: 1, cutOffs: 0, retryAt: null },
      append: [],
      deliver: [],
      leaveOutFrom: null,
      ...more,
    });

    const create = async (more: Partial<Actor> = {}, agent = agentId()) => {
      const actor = actorOf(agent, more);
      await store.createActor(actor);
      return actor;
    };

    beforeEach(async () => {
      store = await open();
    });
    afterEach(async () => {
      await store.close();
    });

    it('keeps a new actor idle, with nothing said and nothing owed', async () => {
      const actor = actorOf(agentId());
      const { record, created } = await store.createActor(actor);

      expect(created).toBe(true);
      expect(record).toEqual({ actor, turn: { phase: 'idle' }, epoch: 0, nextSeq: 1 });
      expect(await store.loadActor(actor.id)).toEqual(record);
      expect(await store.conversation(actor.id)).toEqual([]);
      expect(await store.unfinished()).toEqual([]);
    });

    it('has no actor of an ID it was never given', async () => {
      expect(await store.loadActor(actorOf(agentId()).id)).toBeUndefined();
    });

    it('gives back the actor of an external ID its agent has, and makes none', async () => {
      const agent = agentId();
      const first = await create({ externalId: 'telegram:4411' }, agent);
      const again = await store.createActor(actorOf(agent, { externalId: 'telegram:4411' }));
      expect(again.created).toBe(false);
      expect(again.record.actor.id).toBe(first.id);

      // The same external ID under another agent is another actor.
      const other = await store.createActor(actorOf(agentId(), { externalId: 'telegram:4411' }));
      expect(other.created).toBe(true);
    });

    it('refuses a name another actor of the agent has', async () => {
      const agent = agentId();
      await create({ name: 'eu-desk' }, agent);
      await expect(store.createActor(actorOf(agent, { name: 'eu-desk' }))).rejects.toMatchObject({
        name: 'NameTaken',
      });
      expect((await store.createActor(actorOf(agentId(), { name: 'eu-desk' }))).created).toBe(true);
    });

    it('stores a commit whole: the turn, the messages, and the mail it took', async () => {
      const actor = await create();
      const mail = inputOf(actor, 'hello');
      await store.addInput(mail);
      expect((await store.loadActor(actor.id))?.actor.pendingInputs).toBe(1);

      const step = change({ append: [said(1, 'hello')], deliver: [mail.id] });
      await store.commit(actor.id, 0, step);

      const record = await store.loadActor(actor.id);
      expect(record).toMatchObject({ turn: step.turn, epoch: 1, nextSeq: 2 });
      expect(record?.actor).toMatchObject({ status: 'working', pendingInputs: 0 });
      expect(await store.conversation(actor.id)).toEqual([said(1, 'hello')]);
      expect(await store.pendingInputs(actor.id)).toEqual([]);
    });

    it('refuses a commit that read an epoch since passed, and stores none of it', async () => {
      const actor = await create();
      await store.commit(actor.id, 0, change({ append: [said(1, 'first')] }));

      await expect(
        store.commit(actor.id, 0, change({ append: [said(2, 'late')] })),
      ).rejects.toMatchObject({ name: 'StaleEpoch' });
      expect(await store.conversation(actor.id)).toEqual([said(1, 'first')]);
      expect((await store.loadActor(actor.id))?.epoch).toBe(1);
    });

    it('lets one of two commits through that read the same epoch', async () => {
      const actor = await create();
      const tried = await Promise.allSettled([
        store.commit(actor.id, 0, change({ append: [said(1, 'one')] })),
        store.commit(actor.id, 0, change({ append: [said(1, 'two')] })),
      ]);
      expect(tried.map((one) => one.status).toSorted()).toEqual(['fulfilled', 'rejected']);
      expect(await store.conversation(actor.id)).toHaveLength(1);
    });

    it('stores the commits of many actors that come at once, each whole', async () => {
      const actors = await Promise.all(Array.from({ length: 40 }, () => create()));
      await Promise.all(
        actors.map((actor) => store.commit(actor.id, 0, change({ append: [said(1, actor.id)] }))),
      );
      const records = await Promise.all(actors.map((actor) => store.loadActor(actor.id)));
      expect(records.map((record) => record?.epoch)).toEqual(actors.map(() => 1));
      expect((await store.conversation((actors[39] as Actor).id))[0]).toEqual(
        said(1, (actors[39] as Actor).id),
      );
    });

    it('keeps the turn it is given, whatever its shape', async () => {
      const actor = await create();
      const turn = {
        phase: 'tools',
        startSeq: 1,
        calls: [{ id: 'c1', name: 'lookup_order', arguments: { id: 4411 }, result: null }],
      } as const;
      await store.commit(actor.id, 0, change({ turn }));
      expect((await store.loadActor(actor.id))?.turn).toEqual(turn);

      const lastTurn = { end: 'failed', at: NOW, reason: 'overloaded' } as const;
      await store.commit(
        actor.id,
        1,
        change({ turn: { phase: 'idle' }, status: 'archived', lastTurn, archivedAt: NOW + 9 }),
      );
      expect((await store.loadActor(actor.id))?.actor).toMatchObject({
        status: 'archived',
        lastTurn,
        archivedAt: NOW + 9,
      });
    });

    it('takes an input once for an external ID, and finds it by that', async () => {
      const actor = await create();
      const first = inputOf(actor, 'hello', 'update-9');
      expect(await store.addInput(first)).toBe('accepted');
      expect(await store.addInput(inputOf(actor, 'hello', 'update-9'))).toBe('duplicate');
      expect(await store.findInput(actor.id, 'update-9')).toBe(first.id);
      expect(await store.findInput(actor.id, 'update-10')).toBeUndefined();

      // Inputs with no external ID are never the same one.
      expect(await store.addInput(inputOf(actor, 'hello'))).toBe('accepted');
      expect(await store.addInput(inputOf(actor, 'hello'))).toBe('accepted');
      expect(await store.pendingInputs(actor.id)).toHaveLength(3);
    });

    it('gives the mail that waits in the order it came, without what a turn took', async () => {
      const actor = await create();
      const mail = [inputOf(actor, 'one'), inputOf(actor, 'two'), inputOf(actor, 'three')];
      for (const input of mail) await store.addInput(input);
      await store.commit(actor.id, 0, change({ deliver: [(mail[1] as Input).id] }));

      expect(await store.pendingInputs(actor.id)).toEqual([mail[0], mail[2]]);
      expect((await store.loadActor(actor.id))?.actor.pendingInputs).toBe(2);
    });

    it('reads a part of a conversation: after a place, and so many', async () => {
      const actor = await create();
      const entries = [1, 2, 3, 4, 5].map((seq) => said(seq, `message ${String(seq)}`));
      await store.commit(actor.id, 0, change({ append: entries }));

      expect(await store.conversation(actor.id, { after: 2 })).toEqual(entries.slice(2));
      expect(await store.conversation(actor.id, { after: 1, limit: 2 })).toEqual(
        entries.slice(1, 3),
      );
      expect(await store.conversation(actor.id, { limit: 0 })).toEqual([]);
    });

    it('marks messages left out from a place on, and keeps them', async () => {
      const actor = await create();
      await store.commit(actor.id, 0, change({ append: [said(1, 'kept'), said(2, 'declined')] }));
      await store.commit(
        actor.id,
        1,
        change({ append: [{ ...said(3, 'refusal'), leftOut: true }], leaveOutFrom: 2 }),
      );
      expect((await store.conversation(actor.id)).map((entry) => entry.leftOut ?? false)).toEqual([
        false,
        true,
        true,
      ]);
    });

    it('says which actors have something owed: a turn under way, or mail that waits', async () => {
      const idle = await create();
      const working = await create();
      const mailed = await create();
      await store.commit(working.id, 0, change());
      await store.addInput(inputOf(mailed, 'hello'));

      expect((await store.unfinished()).toSorted()).toEqual([working.id, mailed.id].toSorted());

      await store.commit(working.id, 1, change({ status: 'idle', turn: { phase: 'idle' } }));
      expect(await store.unfinished()).toEqual([mailed.id]);
      expect(await store.loadActor(idle.id)).toBeDefined();
    });
  });
}
