// What every store must do, whatever it is made of. The store in memory is held to this here,
// and the store on SQLite in its own package, by the same tests.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeId } from '@acentric/protocol';
import type {
  Actor,
  Agent,
  AgentDefinition,
  AgentId,
  ConversationEntry,
  Deployment,
  Input,
} from '@acentric/protocol';

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
      pinned: false,
      behind: null,
      modelId: 'fake-1',
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
      set: null,
      sent: null,
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
      expect(record).toEqual({
        actor,
        turn: { phase: 'idle' },
        epoch: 0,
        nextSeq: 1,
        configurationGiven: null,
        sent: null,
        reasoningFrom: 1,
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
        expect(await store.listAgents()).toEqual([agent]);
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
      });
    });
  });
}
