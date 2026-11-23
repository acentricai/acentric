// Subagents, through the API: the actors an actor spawned are listed, stopping an actor says
// which of them it stopped, and a key for an actor reads the actors under it and no more.

import { describe, expect, it } from 'vitest';

import { calls, says } from '@acentric/ai/testing';

import { api, refusal } from './api.ts';

/** A server with a lead that has spawned a worker, of another agent, and sent it a message. */
async function withTree() {
  const one = await api([
    calls({ id: 'c1', name: 'spawn_agent', arguments: { agent: 'billing', name: 'worker' } }),
    calls({ id: 'c2', name: 'message_agent', arguments: { to: 'worker', message: 'Bill it.' } }),
    says('Asked.'),
    // The worker's own turn, for the message it was sent.
    says('Billed.'),
  ]);
  const { admin, deploy, say, engine } = one;
  const lead = await deploy('lead', 'lead@1');
  await deploy('billing', 'billing@1');
  const { actor } = await admin.call('actors.create', {
    params: { agent: lead.agent.id },
    body: {},
  });
  await say(actor.id, 'Bill order 4411.');
  await engine.settled();
  const { items } = await admin.call('actors.subagents', { params: { actor: actor.id } });
  const [worker] = items;
  if (worker === undefined) throw new Error('No subagent was spawned');
  return { ...one, actor, worker };
}

describe('the actors an actor spawned', () => {
  it('are listed under it, say which actor spawned them, and are found by it among all actors', async () => {
    const { admin, actor, worker, failures } = await withTree();
    expect(worker).toMatchObject({ parent: { id: actor.id, name: 'worker' }, status: 'idle' });
    expect(actor.parent).toBeNull();
    const listed = await admin.call('actors.list', { query: { parent: actor.id } });
    expect(listed.items.map((one) => one.id)).toEqual([worker.id]);
    expect((await admin.call('actors.list', { query: { parent: worker.id } })).items).toEqual([]);
    expect((await admin.call('actors.subagents', { params: { actor: worker.id } })).items).toEqual(
      [],
    );
    // It is an actor like any other: it has a conversation of its own.
    const said = await admin.call('messages.list', { params: { actor: worker.id }, query: {} });
    expect(said.items).toHaveLength(2);
    expect(failures).toEqual([]);
  });

  it('are stopped with it, and the answer says which', async () => {
    const { admin, actor, worker } = await withTree();
    const stopped = await admin.call('actors.abort', { params: { actor: actor.id } });
    expect(stopped).toMatchObject({ interrupted: false, tasks: [], agents: ['worker'] });
    expect((await admin.call('actors.abort', { params: { actor: worker.id } })).agents).toEqual([]);
  });

  it('are what a key for the actor reads, and no more: nothing above it, and nothing of another', async () => {
    const { admin, keyed, actor, worker, deploy } = await withTree();
    const other = await admin.call('actors.create', {
      params: { agent: (await deploy('orders')).agent.id },
      body: {},
    });
    const permissions = ['actors:read', 'actors:send', 'actors:stop'] as const;
    const ofLead = await keyed({
      scope: { type: 'actor', actor: actor.id },
      permissions: [...permissions],
    });
    const ofWorker = await keyed({
      scope: { type: 'actor', actor: worker.id },
      permissions: [...permissions],
    });

    // The one above reads the one below: itself, its conversation and what it spawned.
    expect((await ofLead.client.call('actors.get', { params: { actor: worker.id } })).id).toBe(
      worker.id,
    );
    expect(
      (await ofLead.client.call('messages.list', { params: { actor: worker.id }, query: {} }))
        .items,
    ).toHaveLength(2);
    expect(
      (await ofLead.client.call('actors.subagents', { params: { actor: actor.id } })).items,
    ).toHaveLength(1);
    // And does nothing to it: what can be watched and not touched says so.
    expect(
      await refusal(
        ofLead.client.call('inputs.send', {
          params: { actor: worker.id },
          body: { type: 'message', payload: { text: 'Hello.' } },
        }),
      ),
    ).toEqual({ code: 'forbidden', status: 403 });
    expect(
      await refusal(ofLead.client.call('actors.abort', { params: { actor: worker.id } })),
    ).toEqual({ code: 'forbidden', status: 403 });

    // The one below sees nothing above it, and neither sees what is no part of the tree.
    expect(
      await refusal(ofWorker.client.call('actors.get', { params: { actor: actor.id } })),
    ).toEqual({ code: 'not_found', status: 404 });
    for (const { client } of [ofLead, ofWorker]) {
      expect(
        await refusal(client.call('actors.get', { params: { actor: other.actor.id } })),
      ).toEqual({ code: 'not_found', status: 404 });
    }
  });

  it('are in what was used, under the actor at the top of their tree', async () => {
    const { admin, actor, worker } = await withTree();
    const report = await admin.call('usage.get', { query: { by: 'root' } });
    expect(report.groups?.map((group) => group.key)).toEqual([actor.id]);
    expect(report.groups?.[0]?.totals.calls).toBe(4);
    const under = await admin.call('usage.get', { query: { root: actor.id, by: 'actor' } });
    expect(under.groups?.map((group) => group.key).toSorted()).toEqual(
      [actor.id, worker.id].toSorted(),
    );
  });
});
