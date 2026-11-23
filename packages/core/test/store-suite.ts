// What every store must do, whatever it is made of. The store in memory is held to this here,
// and the store on SQLite in its own package, by the same tests.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeId } from '@acentric/protocol';
import type {
  Actor,
  Agent,
  AgentDefinition,
  AgentId,
  AuditEvent,
  ConversationEntry,
  Deployment,
  Input,
  KeyId,
  User,
  UserId,
} from '@acentric/protocol';

import type { Change } from '../src/state.ts';
import type { UsageRecord } from '../src/usage.ts';
import type {
  Paged,
  Store,
  NewTask,
  StoredAccount,
  StoredBlob,
  StoredKey,
  StoredLink,
  StoredSession,
  StoredUser,
  TaskEnding,
} from '../src/store.ts';

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
      pinned: false,
      behind: null,
      modelId: 'fake-1',
      reasoning: 'medium',
      configuration: { region: 'eu' },
      machine: null,
      parent: null,
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
      set: null,
      sent: null,
      usage: null,
      ...more,
    });

    const create = async (more: Partial<Actor> = {}, agent = agentId()) => {
      const actor = actorOf(agent, more);
      await store.createActor(actor);
      return actor;
    };

    /** An agent that is there, with one deployment: one that can be deleted. */
    const stored = async (called: string): Promise<AgentId> => {
      const id = agentId();
      const ref = { id: makeId('deployment', { now: NOW, random: random() }), version: 1 };
      await store.addDeployment({
        agent: {
          id,
          name: called,
          provider: 'fake',
          activeDeployment: ref,
          latestDeployment: ref,
          account: null,
          createdAt: NOW,
        },
        deployment: {
          ...ref,
          agent: id,
          hash: 'a'.repeat(64),
          manifest: { protocol: 1, sdk: '0.15.0' },
          definition: {
            provider: 'fake',
            instructions: '',
            configuration: null,
            tools: [],
            inputs: [],
          },
          createdBy: { type: 'system' },
          createdAt: NOW,
        },
        code: called,
      });
      return id;
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
      expect(record).toEqual({
        actor,
        turn: { phase: 'idle' },
        epoch: 0,
        nextSeq: 1,
        configurationGiven: null,
        sent: null,
        reasoningFrom: 1,
        reasoningSent: null,
      });
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

    describe('agents and their deployments', () => {
      const definition: AgentDefinition = {
        provider: 'fake',
        instructions: 'You answer questions about orders.',
        configuration: null,
        tools: [],
        inputs: [{ type: 'message', schema: null }],
      };
      const deploymentOf = (agent: AgentId, version: number): Deployment => ({
        id: makeId('deployment', { now: NOW, random: random() }),
        agent,
        version,
        hash: String(version).repeat(64).slice(0, 64),
        manifest: { protocol: 1, sdk: '0.15.0' },
        definition,
        createdBy: { type: 'system' },
        createdAt: NOW + version,
      });
      const agentOf = (
        id: AgentId,
        called: string,
        active: Deployment,
        latest = active,
      ): Agent => ({
        id,
        name: called,
        provider: 'fake',
        activeDeployment: { id: active.id, version: active.version },
        latestDeployment: { id: latest.id, version: latest.version },
        account: null,
        createdAt: NOW,
      });
      /** An agent with two deployments, the second the active one. */
      const deployed = async (called = 'orders') => {
        const id = agentId();
        const one = deploymentOf(id, 1);
        const two = deploymentOf(id, 2);
        await store.addDeployment({ agent: agentOf(id, called, one), deployment: one, code: 'v1' });
        const agent = agentOf(id, called, two);
        await store.addDeployment({ agent, deployment: two, code: 'v2' });
        return { agent, one, two };
      };

      it('keeps a deployment with its code, and its agent as it then is', async () => {
        const { agent, one, two } = await deployed();
        expect(await store.loadAgent(agent.id)).toEqual(agent);
        expect(await store.findAgent('orders')).toEqual(agent);
        expect(await store.listAgents()).toEqual({ items: [agent], nextCursor: null });
        expect(await store.loadDeployment(one.id)).toEqual({ deployment: one, code: 'v1' });
        expect(await store.loadDeployment(two.id)).toEqual({ deployment: two, code: 'v2' });
        expect(await store.findDeployment(agent.id, 2)).toEqual(two);
      });

      it('has nothing for what it was never given', async () => {
        const { agent } = await deployed();
        expect(await store.loadAgent(agentId())).toBeUndefined();
        expect(await store.findAgent('billing')).toBeUndefined();
        expect(await store.findDeployment(agent.id, 3)).toBeUndefined();
        expect(
          await store.loadDeployment(makeId('deployment', { now: NOW, random: random() })),
        ).toBeUndefined();
      });

      it('refuses a new agent a name another has, and keeps nothing of it', async () => {
        await deployed();
        const id = agentId();
        const one = deploymentOf(id, 1);
        const adding = store.addDeployment({
          agent: agentOf(id, 'orders', one),
          deployment: one,
          code: 'x',
        });
        await expect(adding).rejects.toMatchObject({ name: 'NameTaken', code: 'name_taken' });
        expect(await store.loadDeployment(one.id)).toBeUndefined();
        expect(await store.loadAgent(id)).toBeUndefined();
      });

      it('refuses a deployment that does not follow its agent’s newest', async () => {
        const { agent, two } = await deployed();
        for (const version of [2, 4]) {
          const out = deploymentOf(agent.id, version);
          await expect(
            store.addDeployment({
              agent: agentOf(agent.id, 'orders', out),
              deployment: out,
              code: 'x',
            }),
          ).rejects.toMatchObject({ name: 'OutOfOrder' });
        }
        expect((await store.loadAgent(agent.id))?.latestDeployment.id).toBe(two.id);
      });

      it('makes another version the active one, and the newest stays the newest', async () => {
        const { agent, one, two } = await deployed();
        const back = await store.setActive(agent.id, 1);
        expect(back).toEqual({ ...agent, activeDeployment: { id: one.id, version: 1 } });
        expect(await store.loadAgent(agent.id)).toEqual(back);
        expect(back?.latestDeployment).toEqual({ id: two.id, version: 2 });
        // A version the agent has not, and an agent there is not.
        expect(await store.setActive(agent.id, 9)).toBeUndefined();
        expect(await store.setActive(agentId(), 1)).toBeUndefined();
      });

      it('keeps an agent’s secrets sealed, by name, and each agent’s own', async () => {
        const [mine, other] = [agentId(), agentId()];
        const secret = (agent: AgentId, called: string, sealed: string) => ({
          agent,
          name: called,
          sealed,
          updatedAt: NOW,
        });
        await store.setSecret(secret(mine, 'ORDERS_API_KEY', 'sealed-1'));
        await store.setSecret(secret(mine, 'BILLING_KEY', 'sealed-2'));
        await store.setSecret(secret(other, 'ORDERS_API_KEY', 'sealed-3'));
        await store.setSecret({
          ...secret(mine, 'ORDERS_API_KEY', 'sealed-4'),
          updatedAt: NOW + 1,
        });

        expect(await store.secretNames(mine)).toEqual(['BILLING_KEY', 'ORDERS_API_KEY']);
        expect(await store.getSecret(mine, 'ORDERS_API_KEY')).toEqual({
          ...secret(mine, 'ORDERS_API_KEY', 'sealed-4'),
          updatedAt: NOW + 1,
        });
        expect((await store.getSecret(other, 'ORDERS_API_KEY'))?.sealed).toBe('sealed-3');
        expect(await store.getSecret(mine, 'NONE')).toBeUndefined();
        expect(await store.allSecrets()).toHaveLength(3);

        expect(await store.deleteSecret(mine, 'BILLING_KEY')).toBe(true);
        expect(await store.deleteSecret(mine, 'BILLING_KEY')).toBe(false);
        expect(await store.secretNames(mine)).toEqual(['ORDERS_API_KEY']);
      });
    });

    describe('what a step changes of the actor itself', () => {
      const idle = (more: Partial<Change> = {}) =>
        change({ status: 'idle', turn: { phase: 'idle' }, ...more });

      it('is stored with the step, and what it does not name stays', async () => {
        const actor = await create({ name: 'eu-desk' });
        const next = { id: makeId('deployment', { now: NOW, random: random() }), version: 2 };
        const behind = { deployment: next, reason: 'region: Required' };
        await store.commit(actor.id, 0, idle({ set: { behind } }));
        expect((await store.loadActor(actor.id))?.actor).toEqual({ ...actor, behind });

        const set = {
          name: null,
          modelId: 'fake-2',
          reasoning: 'high',
          configuration: { region: 'us' },
          configurationGiven: { region: 'us', extra: true },
          deployment: next,
          pinned: true,
          behind: null,
        } as const;
        await store.commit(actor.id, 1, idle({ set }));
        const record = await store.loadActor(actor.id);
        const { configurationGiven, ...fields } = set;
        expect(record?.actor).toEqual({ ...actor, ...fields });
        expect(record?.configurationGiven).toEqual(configurationGiven);
      });

      it('keeps an actor’s configuration as it was given beside the one its schema made', async () => {
        const actor = actorOf(agentId());
        await store.createActor(actor, { region: 'eu', extra: true });
        expect((await store.loadActor(actor.id))?.configurationGiven).toEqual({
          region: 'eu',
          extra: true,
        });
        await store.commit(actor.id, 0, idle({ set: { configurationGiven: null } }));
        expect((await store.loadActor(actor.id))?.configurationGiven).toBeNull();
      });

      it('refuses to name an actor as another of its agent is, and stores none of the step', async () => {
        const agent = agentId();
        await create({ name: 'eu-desk' }, agent);
        const other = await create({ name: 'us-desk' }, agent);
        await expect(
          store.commit(other.id, 0, idle({ set: { name: 'eu-desk', modelId: 'fake-2' } })),
        ).rejects.toMatchObject({ name: 'NameTaken' });
        expect(await store.loadActor(other.id)).toMatchObject({
          epoch: 0,
          actor: { name: 'us-desk', modelId: 'fake-1' },
        });
        // Its own name again, and a name of another agent's actor, are no one else's.
        await store.commit(other.id, 0, idle({ set: { name: 'us-desk' } }));
        const elsewhere = await create();
        await store.commit(elsewhere.id, 0, idle({ set: { name: 'eu-desk' } }));
      });

      it('finds an actor by its agent and the caller’s own ID for it', async () => {
        const agent = agentId();
        const actor = await create({ externalId: 'telegram:4411' }, agent);
        expect((await store.findActor(agent, 'telegram:4411'))?.actor.id).toBe(actor.id);
        expect(await store.findActor(agent, 'telegram:1')).toBeUndefined();
        expect(await store.findActor(agentId(), 'telegram:4411')).toBeUndefined();
      });

      it('keeps where the model’s reasoning is sent from, with what its last call was made with', async () => {
        const actor = await create();
        await store.commit(actor.id, 0, change());
        expect(await store.loadActor(actor.id)).toMatchObject({ sent: null, reasoningFrom: 1 });
        await store.commit(actor.id, 1, change({ sent: { fingerprint: 'abc', reasoningFrom: 5 } }));
        expect(await store.loadActor(actor.id)).toMatchObject({ sent: 'abc', reasoningFrom: 5 });
        // A step that made no call leaves both.
        await store.commit(actor.id, 2, change());
        expect(await store.loadActor(actor.id)).toMatchObject({ sent: 'abc', reasoningFrom: 5 });
        // The level its calls are sent with, where that is not the level it is at.
        expect((await store.loadActor(actor.id))?.reasoningSent).toBeNull();
        await store.commit(actor.id, 3, change({ set: { reasoningSent: 'low' } }));
        expect((await store.loadActor(actor.id))?.reasoningSent).toBe('low');
        await store.commit(actor.id, 4, change({ set: { reasoningSent: null } }));
        expect((await store.loadActor(actor.id))?.reasoningSent).toBeNull();
      });
    });

    describe('lists', () => {
      /** Every page of a list, read `limit` at a time. */
      const pages = async <T>(
        read: (page: { limit: number; cursor?: string }) => Promise<Paged<T>>,
        limit: number,
      ): Promise<T[][]> => {
        const all: T[][] = [];
        let cursor: string | undefined;
        do {
          const page = await read({ limit, ...(cursor === undefined ? {} : { cursor }) });
          all.push(page.items);
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
        return all;
      };

      it('give actors newest first, a page at a time, with no page after the last', async () => {
        const agent = agentId();
        const created = [];
        for (let index = 0; index < 5; index += 1) created.push(await create({}, agent));
        const newestFirst = created.map((actor) => actor.id).toReversed();

        const read = await pages((page) => store.listActors({ ...page, agent }), 2);
        expect(read.map((page) => page.map((actor) => actor.id))).toEqual([
          newestFirst.slice(0, 2),
          newestFirst.slice(2, 4),
          newestFirst.slice(4),
        ]);
        // A page that ends where the list does says so, and is not followed by an empty one.
        expect((await store.listActors({ limit: 5, agent })).nextCursor).toBeNull();
      });

      it('narrow actors by their agent, themselves, where they stand, their name and the caller’s ID', async () => {
        const [mine, other] = [agentId(), agentId()];
        const named = await create({ name: 'eu-desk', externalId: 'telegram:1' }, mine);
        const working = await create({}, mine);
        const elsewhere = await create({ name: 'eu-desk' }, other);
        await store.commit(working.id, 0, change());
        await store.addInput(inputOf(named, 'hello'));
        const ids = async (query: Parameters<Store['listActors']>[0]) =>
          (await store.listActors(query)).items.map((actor) => actor.id);

        expect(await ids({ limit: 10, agent: mine })).toEqual([working.id, named.id]);
        expect(await ids({ limit: 10, actor: named.id })).toEqual([named.id]);
        expect(await ids({ limit: 10, status: 'working' })).toEqual([working.id]);
        expect(await ids({ limit: 10, name: 'eu-desk' })).toEqual([elsewhere.id, named.id]);
        expect(await ids({ limit: 10, agent: mine, externalId: 'telegram:1' })).toEqual([named.id]);
        expect(await ids({ limit: 10, agent: other, actor: named.id })).toEqual([]);
        // What it lists is the actor as it stands, with what waits for it.
        const [listed] = (await store.listActors({ limit: 10, actor: named.id })).items;
        expect(listed).toEqual((await store.loadActor(named.id))?.actor);
        expect(listed?.pendingInputs).toBe(1);
      });

      it('give what an actor was sent, newest first: all of it, what waits, or what a turn took', async () => {
        const actor = await create();
        const inputs = [];
        for (const text of ['one', 'two', 'three']) {
          const input = inputOf(actor, text);
          inputs.push(input);
          await store.addInput(input);
        }
        const [first, second, third] = inputs.map((input) => input.id);
        await store.commit(actor.id, 0, change({ deliver: [first as never] }));
        const ids = async (query: Parameters<Store['listInputs']>[1]) =>
          (await store.listInputs(actor.id, query)).items.map((input) => input.id);

        expect(await ids({ limit: 10 })).toEqual([third, second, first]);
        expect(await ids({ limit: 10, pending: true })).toEqual([third, second]);
        expect(await ids({ limit: 10, pending: false })).toEqual([first]);
        const page = await store.listInputs(actor.id, { limit: 2 });
        expect(page.items.map((input) => input.id)).toEqual([third, second]);
        expect(await ids({ limit: 2, cursor: page.nextCursor ?? '' })).toEqual([first]);
      });

      it('read a conversation from either end, and between two places', async () => {
        const actor = await create();
        await store.commit(
          actor.id,
          0,
          change({ append: [1, 2, 3, 4, 5].map((seq) => said(seq, `message ${String(seq)}`)) }),
        );
        const seqs = async (part: Parameters<Store['conversation']>[1]) =>
          (await store.conversation(actor.id, part)).map((entry) => entry.seq);

        expect(await seqs({ order: 'desc', limit: 2 })).toEqual([5, 4]);
        expect(await seqs({ order: 'desc', before: 4, limit: 2 })).toEqual([3, 2]);
        expect(await seqs({ after: 1, before: 5 })).toEqual([2, 3, 4]);
        expect(await seqs({ after: 3 })).toEqual([4, 5]);
      });
    });

    describe('deleting an agent', () => {
      it('removes everything of it and nothing of another, and says what went', async () => {
        const id = agentId();
        const deployment: Deployment = {
          id: makeId('deployment', { now: NOW, random: random() }),
          agent: id,
          version: 1,
          hash: 'a'.repeat(64),
          manifest: { protocol: 1, sdk: '0.15.0' },
          definition: {
            provider: 'fake',
            instructions: '',
            configuration: null,
            tools: [],
            inputs: [],
          },
          createdBy: { type: 'system' },
          createdAt: NOW,
        };
        const ref = { id: deployment.id, version: 1 };
        const agent: Agent = {
          id,
          name: 'orders',
          provider: 'fake',
          activeDeployment: ref,
          latestDeployment: ref,
          account: null,
          createdAt: NOW,
        };
        await store.addDeployment({ agent, deployment, code: 'v1' });
        await store.setSecret({ agent: id, name: 'KEY', sealed: 's', updatedAt: NOW });
        const actor = await create({}, id);
        await store.addInput(inputOf(actor, 'hello'));
        await store.commit(actor.id, 0, change({ append: [said(1, 'hello')] }));
        const other = await create();
        await store.addInput(inputOf(other, 'still here'));

        expect(await store.deleteAgent(id)).toEqual({
          deployments: [deployment.id],
          actors: [actor.id],
        });
        expect(await store.loadAgent(id)).toBeUndefined();
        expect(await store.findAgent('orders')).toBeUndefined();
        expect(await store.loadDeployment(deployment.id)).toBeUndefined();
        expect(await store.secretNames(id)).toEqual([]);
        expect(await store.loadActor(actor.id)).toBeUndefined();
        expect(await store.conversation(actor.id)).toEqual([]);
        expect(await store.unfinished()).toEqual([other.id]);
        // Its name is free again, and there is no agent of it to delete twice.
        expect(await store.deleteAgent(id)).toBeUndefined();
        await store.addDeployment({ agent, deployment, code: 'v1' });
      });
    });

    describe('API keys', () => {
      const keyOf = (parent: KeyId | null = null): StoredKey => {
        const id = makeId('key', { now: NOW, random: random() });
        return {
          key: {
            id,
            label: 'for the support service',
            owner: null,
            scope: { type: 'engine' },
            permissions: ['actors:read'],
            expiresAt: null,
            createdBy: parent === null ? { type: 'system' } : { type: 'key', id: parent },
            createdAt: NOW,
            lastUsedAt: null,
          },
          hash: 'b'.repeat(64),
          parent,
        };
      };

      it('are kept as they were given, noted when they are used, and gone when they are removed', async () => {
        const first = keyOf();
        const second = keyOf(first.key.id);
        await store.addKey(first);
        await store.addKey(second);
        expect(await store.loadKey(first.key.id)).toEqual(first);
        expect(await store.listKeys()).toEqual([first, second]);

        await store.touchKey(first.key.id, NOW + 5);
        expect((await store.loadKey(first.key.id))?.key.lastUsedAt).toBe(NOW + 5);
        expect((await store.loadKey(second.key.id))?.key.lastUsedAt).toBeNull();

        await store.removeKeys([first.key.id, second.key.id]);
        expect(await store.loadKey(first.key.id)).toBeUndefined();
        expect(await store.listKeys()).toEqual([]);
      });
    });

    describe('people', () => {
      const personOf = (email: string, more: Partial<User> = {}): StoredUser => ({
        user: {
          id: makeId('user', { now: NOW, random: random() }),
          email,
          displayName: null,
          role: 'member',
          createdAt: NOW,
          disabledAt: null,
          ...more,
        },
        password: `hash-of-${email}`,
      });
      const sessionOf = (user: UserId): StoredSession => ({
        session: {
          id: makeId('session', { now: NOW, random: random() }),
          user,
          client: 'dashboard',
          label: null,
          createdAt: NOW,
          lastUsedAt: null,
          expiresAt: NOW + 1000,
        },
        hash: 'c'.repeat(64),
      });
      const linkOf = (kind: StoredLink['kind'], more: Partial<StoredLink> = {}): StoredLink => ({
        id: makeId('invite', { now: NOW, random: random() }),
        kind,
        hash: 'd'.repeat(64),
        role: kind === 'reset' ? null : 'member',
        user: null,
        note: null,
        createdBy: { type: 'system' },
        createdAt: NOW,
        expiresAt: NOW + 1000,
        ...more,
      });

      it('are kept, found by what they sign in as, changed and removed', async () => {
        const ada = personOf('ada@example.com', { role: 'owner' });
        const grace = personOf('grace@example.com');
        await store.addUser(ada);
        await store.addUser(grace);
        expect(await store.loadUser(ada.user.id)).toEqual(ada);
        expect(await store.findUser('grace@example.com')).toEqual(grace);
        expect(await store.findUser('nobody@example.com')).toBeUndefined();
        expect(await store.listUsers()).toEqual([ada.user, grace.user]);

        const changed = { user: { ...grace.user, role: 'admin' as const }, password: 'another' };
        await store.saveUser(changed);
        expect(await store.loadUser(grace.user.id)).toEqual(changed);

        await store.removeUser(grace.user.id);
        expect(await store.loadUser(grace.user.id)).toBeUndefined();
        // One who is gone is not brought back by being saved.
        await store.saveUser(changed);
        expect(await store.listUsers()).toEqual([ada.user]);
      });

      it('have each their own email', async () => {
        await store.addUser(personOf('ada@example.com'));
        await expect(store.addUser(personOf('ada@example.com'))).rejects.toMatchObject({
          name: 'EmailTaken',
          code: 'conflict',
        });
        expect(await store.listUsers()).toHaveLength(1);
      });

      it('have sessions, which are noted when used, ended one at a time, or all but one', async () => {
        const ada = personOf('ada@example.com');
        const grace = personOf('grace@example.com');
        await store.addUser(ada);
        await store.addUser(grace);
        const [one, two, three] = [
          sessionOf(ada.user.id),
          sessionOf(ada.user.id),
          sessionOf(ada.user.id),
        ];
        const hers = sessionOf(grace.user.id);
        for (const session of [one, two, three, hers]) await store.addSession(session);
        expect(await store.loadSession(one.session.id)).toEqual(one);
        expect(await store.listSessions(ada.user.id)).toEqual([
          one.session,
          two.session,
          three.session,
        ]);

        await store.touchSession(one.session.id, NOW + 5, NOW + 5000);
        expect((await store.loadSession(one.session.id))?.session).toMatchObject({
          lastUsedAt: NOW + 5,
          expiresAt: NOW + 5000,
        });
        await store.removeSession(two.session.id);
        await store.removeSessions(ada.user.id, one.session.id);
        expect((await store.listSessions(ada.user.id)).map((session) => session.id)).toEqual([
          one.session.id,
        ]);
        // A person who is removed is signed out everywhere, and no one else is.
        await store.removeUser(ada.user.id);
        expect(await store.loadSession(one.session.id)).toBeUndefined();
        expect(await store.listSessions(grace.user.id)).toEqual([hers.session]);
      });

      it('are made by a link that is used once: of two who use it, one does', async () => {
        const invite = linkOf('invite', { note: 'for Grace' });
        const setup = linkOf('setup', { role: 'owner' });
        await store.addLink(invite);
        await store.addLink(setup);
        expect(await store.loadLink(invite.id)).toEqual(invite);
        expect(await store.listLinks('invite')).toEqual([invite]);

        const grace = personOf('grace@example.com');
        const used = await Promise.all([
          store.redeemLink(invite.id, { addUser: grace }),
          store.redeemLink(invite.id, { addUser: personOf('mallory@example.com') }),
        ]);
        expect(used).toEqual(['done', 'gone']);
        expect(await store.listUsers()).toEqual([grace.user]);
        expect(await store.loadLink(invite.id)).toBeUndefined();
        expect(await store.removeLink(setup.id)).toBe(true);
        expect(await store.removeLink(setup.id)).toBe(false);
      });

      it('keep a link that could not be used: an email that is another’s leaves it for another try', async () => {
        const invite = linkOf('invite');
        await store.addLink(invite);
        await store.addUser(personOf('ada@example.com'));
        await expect(
          store.redeemLink(invite.id, { addUser: personOf('ada@example.com') }),
        ).rejects.toMatchObject({ name: 'EmailTaken' });
        expect(await store.loadLink(invite.id)).toEqual(invite);
        expect(await store.redeemLink(invite.id, { addUser: personOf('grace@example.com') })).toBe(
          'done',
        );
      });

      it('have a password set again by a link, once', async () => {
        const ada = personOf('ada@example.com');
        await store.addUser(ada);
        const reset = linkOf('reset', { user: ada.user.id });
        await store.addLink(reset);
        const setPassword = { user: ada.user.id, password: 'a-new-hash' };
        expect(await store.redeemLink(reset.id, { setPassword })).toBe('done');
        expect(await store.loadUser(ada.user.id)).toEqual({ ...ada, password: 'a-new-hash' });
        expect(await store.redeemLink(reset.id, { setPassword })).toBe('gone');
      });
    });

    describe('the audit log', () => {
      it('is added to, and read newest first, a page at a time, all of it or one kind', async () => {
        const events: AuditEvent[] = ['key.create', 'agent.deploy', 'key.create'].map(
          (action, index) => ({
            id: makeId('auditEvent', { now: NOW + index, random: random() }),
            at: NOW + index,
            by: { type: 'system' },
            action,
            target: index === 1 ? null : { type: 'key', id: `key-${String(index)}` },
            detail: index === 1 ? { version: 2 } : null,
          }),
        );
        for (const event of events) await store.addAuditEvent(event);
        const [first, second, third] = events;

        expect(await store.listAuditEvents({ limit: 10 })).toEqual({
          items: [third, second, first],
          nextCursor: null,
        });
        const page = await store.listAuditEvents({ limit: 2 });
        expect(page.items).toEqual([third, second]);
        expect(
          (await store.listAuditEvents({ limit: 2, cursor: page.nextCursor ?? '' })).items,
        ).toEqual([first]);
        expect((await store.listAuditEvents({ limit: 10, action: 'key.create' })).items).toEqual([
          third,
          first,
        ]);
      });
    });

    describe('model accounts', () => {
      const accountOf = (
        called: string,
        more: Partial<StoredAccount['account']> = {},
      ): StoredAccount => ({
        account: {
          id: makeId('account', { now: NOW, random: random() }),
          provider: 'fake',
          name: called,
          credential: 'api_key',
          default: false,
          owner: null,
          createdBy: { type: 'system' },
          createdAt: NOW,
          ...more,
        },
        sealed: `sealed-${called}`,
      });

      it('are kept sealed, changed and removed, each with a name of its own', async () => {
        const main = accountOf('main', { default: true });
        const spare = accountOf('spare');
        await store.addAccount(main);
        await store.addAccount(spare);
        expect(await store.loadAccount(main.account.id)).toEqual(main);
        expect(await store.listAccounts()).toEqual([main, spare]);
        await expect(store.addAccount(accountOf('main'))).rejects.toMatchObject({
          name: 'NameTaken',
          code: 'name_taken',
        });

        const renamed = {
          ...spare,
          account: { ...spare.account, name: 'backup' },
          sealed: 'again',
        };
        await store.saveAccount(renamed);
        expect(await store.loadAccount(spare.account.id)).toEqual(renamed);
        // Its own name again is no other's, and another's is.
        await store.saveAccount(renamed);
        await expect(
          store.saveAccount({ ...renamed, account: { ...renamed.account, name: 'main' } }),
        ).rejects.toMatchObject({ name: 'NameTaken' });

        await store.removeAccount(spare.account.id);
        expect(await store.loadAccount(spare.account.id)).toBeUndefined();
        expect(await store.listAccounts()).toEqual([main]);
      });

      it('are given to agents, which keep theirs through a deploy', async () => {
        const id = agentId();
        const deploymentOf = (version: number): Deployment => ({
          id: makeId('deployment', { now: NOW, random: random() }),
          agent: id,
          version,
          hash: String(version).repeat(64).slice(0, 64),
          manifest: { protocol: 1, sdk: '0.15.0' },
          definition: {
            provider: 'fake',
            instructions: '',
            configuration: null,
            tools: [],
            inputs: [],
          },
          createdBy: { type: 'system' },
          createdAt: NOW,
        });
        const one = deploymentOf(1);
        const agent: Agent = {
          id,
          name: 'orders',
          provider: 'fake',
          activeDeployment: { id: one.id, version: 1 },
          latestDeployment: { id: one.id, version: 1 },
          account: null,
          createdAt: NOW,
        };
        await store.addDeployment({ agent, deployment: one, code: 'v1' });
        const account = accountOf('main');
        await store.addAccount(account);

        const given = await store.setAgentAccount(id, account.account.id);
        expect(given).toEqual({ ...agent, account: account.account.id });
        expect(await store.agentsOf(account.account.id)).toEqual([id]);
        // A new version is the agent as it is, with the account it has.
        const two = deploymentOf(2);
        const ref = { id: two.id, version: 2 };
        await store.addDeployment({
          agent: {
            ...agent,
            account: account.account.id,
            activeDeployment: ref,
            latestDeployment: ref,
          },
          deployment: two,
          code: 'v2',
        });
        expect((await store.loadAgent(id))?.account).toBe(account.account.id);

        expect((await store.setAgentAccount(id, null))?.account).toBeNull();
        expect(await store.agentsOf(account.account.id)).toEqual([]);
        expect(await store.setAgentAccount(agentId(), null)).toBeUndefined();
      });
    });

    describe('usage', () => {
      const DAY = 86_400_000;
      const usedBy = (actor: Actor, more: Partial<UsageRecord> = {}): UsageRecord => ({
        at: NOW,
        actor: actor.id,
        agent: actor.agent,
        version: 1,
        account: null,
        provider: 'fake',
        model: 'fake-1',
        usage: {
          totalInput: 100,
          input: 20,
          cacheRead: 70,
          cacheWrite: 10,
          output: 30,
          reasoning: 5,
          cost: { source: 'estimated', total: 0.25 },
        },
        failure: null,
        durationMs: 400,
        ...more,
      });
      /** Stores a step for each record, each with its call's usage. */
      const record = async (actor: Actor, records: readonly UsageRecord[]) => {
        let epoch = (await store.loadActor(actor.id))?.epoch ?? 0;
        for (const usage of records) {
          await store.commit(actor.id, epoch, change({ usage }));
          epoch += 1;
        }
      };

      it('is written with the step that ends a call, and adds up', async () => {
        const actor = await create();
        expect(await store.usage()).toEqual({
          totals: {
            calls: 0,
            failed: 0,
            totalInput: 0,
            input: 0,
            cacheRead: 0,
            cacheWrite: 0,
            output: 0,
            reasoning: 0,
            webSearches: 0,
            cost: 0,
            estimatedCost: 0,
            unpriced: 0,
            durationMs: 0,
            first: null,
            last: null,
          },
        });
        await record(actor, [
          usedBy(actor),
          usedBy(actor, {
            at: NOW + 1000,
            usage: {
              totalInput: 50,
              input: 50,
              output: 10,
              webSearches: 2,
              cost: { source: 'reported', total: 0.5 },
            },
          }),
          // Answered, with nothing known of what it cost.
          usedBy(actor, {
            at: NOW + 2000,
            usage: { totalInput: 7, input: 7, output: 3 },
            durationMs: 100,
          }),
          // Failed: nothing was counted.
          usedBy(actor, { at: NOW + 3000, usage: null, failure: 'overloaded', durationMs: 50 }),
        ]);

        expect((await store.usage()).totals).toEqual({
          calls: 4,
          failed: 1,
          totalInput: 157,
          input: 77,
          cacheRead: 70,
          cacheWrite: 10,
          output: 43,
          reasoning: 5,
          webSearches: 2,
          cost: 0.75,
          estimatedCost: 0.25,
          unpriced: 1,
          durationMs: 950,
          first: NOW,
          last: NOW + 3000,
        });
      });

      it('is not written by a step that is refused', async () => {
        const actor = await create();
        await expect(
          store.commit(actor.id, 7, change({ usage: usedBy(actor) })),
        ).rejects.toMatchObject({ name: 'StaleEpoch' });
        expect((await store.usage()).totals.calls).toBe(0);
      });

      it('is narrowed by when, by whom, with what, and added up by each of those', async () => {
        const [orders, billing] = [agentId(), agentId()];
        const one = await create({}, orders);
        const two = await create({}, orders);
        const three = await create({}, billing);
        const account = makeId('account', { now: NOW, random: random() });
        await record(one, [
          usedBy(one, { account }),
          usedBy(one, { at: NOW + DAY, model: 'fake-2', account }),
        ]);
        await record(two, [usedBy(two, { at: NOW + DAY })]);
        await record(three, [
          usedBy(three, { at: NOW + 2 * DAY, provider: 'other', usage: null, failure: 'auth' }),
        ]);
        const calls = async (filter: Parameters<Store['usage']>[0]) =>
          (await store.usage(filter)).totals.calls;

        expect(await calls({})).toBe(4);
        expect(await calls({ agent: orders })).toBe(3);
        expect(await calls({ actor: one.id })).toBe(2);
        expect(await calls({ account })).toBe(2);
        expect(await calls({ model: 'fake-2' })).toBe(1);
        expect(await calls({ provider: 'other' })).toBe(1);
        // From a time on, and up to another but not at it.
        expect(await calls({ from: NOW + DAY })).toBe(3);
        expect(await calls({ from: NOW + DAY, to: NOW + 2 * DAY })).toBe(2);
        expect(await calls({ agent: orders, model: 'fake-1', from: NOW + DAY })).toBe(1);

        const groups = async (by: Parameters<Store['usage']>[1], filter = {}) =>
          (await store.usage(filter, by)).groups?.map((group) => [group.key, group.totals.calls]);
        // What cost most first, and then by what it is of.
        expect(await groups('agent')).toEqual([
          [orders, 3],
          [billing, 1],
        ]);
        expect(await groups('actor', { agent: orders })).toEqual([
          [one.id, 2],
          [two.id, 1],
        ]);
        expect(await groups('model')).toEqual([
          ['fake-1', 3],
          ['fake-2', 1],
        ]);
        expect(await groups('provider')).toEqual([
          ['fake', 3],
          ['other', 1],
        ]);
        // A call that no account says anything of is under none.
        expect(await groups('account')).toEqual([
          [account, 2],
          ['', 2],
        ]);
        const day = (offset: number) => new Date(NOW + offset * DAY).toISOString().slice(0, 10);
        expect(await groups('day')).toEqual([
          [day(1), 2],
          [day(0), 1],
          [day(2), 1],
        ]);
        expect((await store.usage({ agent: orders }, 'agent')).totals.calls).toBe(3);
      });

      it('stays when what it names is gone', async () => {
        const id = await stored('orders');
        const actor = await create({}, id);
        await record(actor, [usedBy(actor)]);
        expect((await store.deleteAgent(id))?.actors).toEqual([actor.id]);
        expect(await store.loadActor(actor.id)).toBeUndefined();
        expect((await store.usage({ actor: actor.id })).totals.calls).toBe(1);
      });
    });

    describe('what waits quietly', () => {
      it('starts no turn: an actor with nothing else is owed nothing', async () => {
        const actor = await create();
        const other = await create();
        await store.addInput(inputOf(actor, 'hello'));
        await store.addInput(inputOf(other, 'hello'));
        expect((await store.unfinished()).toSorted()).toEqual([actor.id, other.id].toSorted());

        await store.quietInputs(actor.id);
        expect(await store.unfinished()).toEqual([other.id]);
        // It still waits, and says that it is quiet.
        expect(await store.pendingInputs(actor.id)).toMatchObject([{ quiet: true }]);
        expect((await store.loadActor(actor.id))?.actor.pendingInputs).toBe(1);
        expect((await store.pendingInputs(other.id))[0]?.quiet).toBeUndefined();

        // What comes after is new, and is not quiet.
        const next = inputOf(actor, 'again');
        await store.addInput(next);
        expect(await store.unfinished()).toContain(actor.id);
        expect((await store.pendingInputs(actor.id)).map((input) => input.quiet)).toEqual([
          true,
          undefined,
        ]);
        // One that is put there quiet is kept so.
        await store.addInput({ ...inputOf(other, 'quietly'), quiet: true });
        expect((await store.pendingInputs(other.id)).map((input) => input.quiet)).toEqual([
          undefined,
          true,
        ]);
      });
    });

    describe('tasks', () => {
      const taskOf = (actor: Actor, callId: string, more: Partial<NewTask> = {}): NewTask => ({
        actor: actor.id,
        kind: 'bash',
        prefix: 'b',
        input: { command: 'make' },
        callId,
        attached: true,
        waitUntil: NOW + 60_000,
        timeoutAt: null,
        startedAt: NOW,
        ...more,
      });
      const ending = (more: Partial<TaskEnding> = {}): TaskEnding => ({
        status: 'done',
        stoppedBy: null,
        result: 'built',
        summary: null,
        images: [],
        endedAt: NOW + 500,
        ...more,
      });
      const notice = (actor: Actor, text: string): Input => ({
        ...inputOf(actor, text),
        type: 'notice',
      });

      it('are stored running, and named by their kind and their number among their actor’s', async () => {
        const actor = await create();
        const other = await create();
        const first = await store.startTask(taskOf(actor, 'c1'));
        expect(first).toEqual({
          actor: actor.id,
          id: 'b1',
          kind: 'bash',
          input: { command: 'make' },
          status: 'running',
          stoppedBy: null,
          callId: 'c1',
          attached: true,
          waitUntil: NOW + 60_000,
          timeoutAt: null,
          result: null,
          summary: null,
          images: [],
          startedAt: NOW,
          endedAt: null,
        });
        const second = await store.startTask(taskOf(actor, 'c2', { startedAt: NOW + 1 }));
        const code = await store.startTask(
          taskOf(actor, 'c3', { kind: 'code', prefix: 'c', startedAt: NOW + 2 }),
        );
        expect([second.id, code.id]).toEqual(['b2', 'c1']);
        expect((await store.startTask(taskOf(other, 'c1'))).id).toBe('b1');

        expect(await store.loadTask(actor.id, 'b2')).toEqual(second);
        expect(await store.loadTask(actor.id, 'b9')).toBeUndefined();
        expect(await store.loadTask(other.id, 'b2')).toBeUndefined();
        // Newest first.
        expect((await store.listTasks(actor.id)).map((task) => task.id)).toEqual([
          'c1',
          'b2',
          'b1',
        ]);
        expect(await store.runningTasks()).toHaveLength(4);
      });

      it('are found again by the call that started them: a call made twice starts one', async () => {
        const actor = await create();
        const first = await store.startTask(taskOf(actor, 'c1'));
        const again = await store.startTask(taskOf(actor, 'c1', { input: { command: 'other' } }));
        expect(again).toEqual(first);
        expect(await store.taskOfCall(actor.id, 'c1')).toEqual(first);
        expect(await store.taskOfCall(actor.id, 'c2')).toBeUndefined();
        expect(await store.listTasks(actor.id)).toHaveLength(1);
      });

      it('are let go of once, while they run and a call waits for them', async () => {
        const actor = await create();
        await store.startTask(taskOf(actor, 'c1'));
        await store.startTask(taskOf(actor, 'c2'));
        await store.startTask(taskOf(actor, 'c3', { attached: false, waitUntil: null }));
        expect(await store.detachTask(actor.id, 'b1')).toBe(true);
        expect(await store.detachTask(actor.id, 'b1')).toBe(false);
        expect(await store.detachTask(actor.id, 'b9')).toBe(false);
        expect((await store.loadTask(actor.id, 'b1'))?.attached).toBe(false);

        // Every one a call still waits for, at once.
        const waited = await store.detachTasks(actor.id);
        expect(waited.map((task) => [task.id, task.attached])).toEqual([['b2', false]]);
        expect(await store.detachTasks(actor.id)).toEqual([]);
        // One that has ended is not let go of.
        await store.startTask(taskOf(actor, 'c4'));
        await store.endTask(actor.id, 'b4', ending(), null);
        expect(await store.detachTask(actor.id, 'b4')).toBe(false);
      });

      it('end once, and a notice is put in the mailbox with the ending only when no call waits', async () => {
        const actor = await create();
        const png = { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } };
        await store.startTask(taskOf(actor, 'c1'));
        await store.startTask(taskOf(actor, 'c2', { attached: false, waitUntil: null }));

        // A call waits for it: its result tells how it ended, and nothing else does.
        expect(await store.endTask(actor.id, 'b1', ending(), notice(actor, 'b1 ended'))).toEqual({
          ended: true,
          notified: false,
        });
        expect(await store.pendingInputs(actor.id)).toEqual([]);
        expect(await store.loadTask(actor.id, 'b1')).toMatchObject({
          status: 'done',
          result: 'built',
          endedAt: NOW + 500,
        });

        const told = notice(actor, 'b2 ended');
        const stopped = ending({
          status: 'stopped',
          stoppedBy: 'timeout',
          summary: 'short',
          images: [png as never],
        });
        expect(await store.endTask(actor.id, 'b2', stopped, told)).toEqual({
          ended: true,
          notified: true,
        });
        expect(await store.pendingInputs(actor.id)).toEqual([told]);
        expect(await store.loadTask(actor.id, 'b2')).toMatchObject({
          status: 'stopped',
          stoppedBy: 'timeout',
          summary: 'short',
          images: [png],
        });
        expect(await store.unfinished()).toEqual([actor.id]);

        // Ended, it is not ended again, and nothing more is told of it.
        expect(await store.endTask(actor.id, 'b2', ending(), notice(actor, 'again'))).toEqual({
          ended: false,
          notified: false,
        });
        expect(await store.endTask(actor.id, 'b9', ending(), null)).toEqual({
          ended: false,
          notified: false,
        });
        expect(await store.pendingInputs(actor.id)).toHaveLength(1);
        expect(await store.loadTask(actor.id, 'b2')).toMatchObject({ status: 'stopped' });
        expect(await store.runningTasks()).toEqual([]);
        expect(await store.listTasks(actor.id, { running: true })).toEqual([]);
      });

      it('go with the agent whose actors had them', async () => {
        const agent = await stored('orders');
        const actor = await create({}, agent);
        const other = await create();
        await store.startTask(taskOf(actor, 'c1'));
        await store.startTask(taskOf(other, 'c1'));
        await store.deleteAgent(agent);
        expect(await store.listTasks(actor.id)).toEqual([]);
        expect((await store.runningTasks()).map((task) => task.actor)).toEqual([other.id]);
      });
    });

    describe('blobs', () => {
      const blobOf = (fill: string, more: Partial<StoredBlob> = {}): StoredBlob => ({
        digest: fill.repeat(64),
        size: 2048,
        mediaType: 'image/png',
        createdAt: NOW,
        ...more,
      });

      it('are known while an actor refers to them, each as the actor first gave it', async () => {
        const first = await create();
        const second = await create();
        const blob = blobOf('a');
        expect(await store.blobOf(first.id, blob.digest)).toBeUndefined();
        expect(await store.listBlobs()).toEqual([]);

        expect(await store.addBlob(first.id, blob)).toBe(true);
        // Kept again, by the same actor or another, it is the one blob.
        expect(await store.addBlob(first.id, blobOf('a', { mediaType: 'image/jpeg' }))).toBe(true);
        expect(await store.addBlob(second.id, blobOf('a', { mediaType: 'image/webp' }))).toBe(true);
        expect(await store.addBlob(second.id, blobOf('b', { size: 7 }))).toBe(true);

        expect(await store.blobOf(first.id, blob.digest)).toEqual(blob);
        expect(await store.blobOf(second.id, blob.digest)).toEqual({
          ...blob,
          mediaType: 'image/webp',
        });
        // One actor has nothing of what only another refers to.
        expect(await store.blobOf(first.id, 'b'.repeat(64))).toBeUndefined();
        expect((await store.listBlobs()).toSorted()).toEqual([blob.digest, 'b'.repeat(64)]);
      });

      it('are not kept for an actor there is not', async () => {
        const nobody = actorOf(agentId());
        expect(await store.addBlob(nobody.id, blobOf('a'))).toBe(false);
        expect(await store.listBlobs()).toEqual([]);
        expect(await store.blobOf(nobody.id, 'a'.repeat(64))).toBeUndefined();
      });

      it('are forgotten once the last actor that referred to them is deleted', async () => {
        const orders = await stored('orders');
        const billing = await stored('billing');
        const first = await create({}, orders);
        const second = await create({}, billing);
        await store.addBlob(first.id, blobOf('a'));
        await store.addBlob(first.id, blobOf('b'));
        await store.addBlob(second.id, blobOf('b'));
        // While something refers to each, nothing is forgotten.
        expect(await store.dropUnreferencedBlobs()).toEqual([]);

        await store.deleteAgent(orders);
        expect(await store.blobOf(first.id, 'a'.repeat(64))).toBeUndefined();
        expect(await store.dropUnreferencedBlobs()).toEqual(['a'.repeat(64)]);
        expect(await store.listBlobs()).toEqual(['b'.repeat(64)]);
        expect(await store.blobOf(second.id, 'b'.repeat(64))).toBeDefined();

        await store.deleteAgent(billing);
        expect(await store.dropUnreferencedBlobs()).toEqual(['b'.repeat(64)]);
        expect(await store.listBlobs()).toEqual([]);
        expect(await store.dropUnreferencedBlobs()).toEqual([]);
      });
    });
  });
}
