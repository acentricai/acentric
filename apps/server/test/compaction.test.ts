// Compaction, through the API: an actor's conversation is compacted when asked, what was
// compacted is listed, and the calls of a model that compacted are counted apart.

import { describe, expect, it } from 'vitest';

import { ModelFailure } from '@acentric/ai';
import { says } from '@acentric/ai/testing';
import type { Scripted } from '@acentric/ai/testing';

import { api, refusal } from './api.ts';

/** A server with an actor that has had two turns, whose agent keeps little of a conversation as it is. */
async function withTalk(...more: (string | Scripted)[]) {
  const one = await api([
    says('It was refunded twice.'),
    says('Order 7 is fine.'),
    ...more.map((next) => (typeof next === 'string' ? says(next) : next)),
  ]);
  const { admin, deploy, say } = one;
  const { agent } = await deploy('orders', 'orders@small');
  const { actor } = await admin.call('actors.create', { params: { agent: agent.id }, body: {} });
  await say(actor.id, 'Why two refunds?');
  await say(actor.id, 'And order 7?');
  return { ...one, actor, params: { actor: actor.id } };
}

describe('compacting an actor’s conversation', () => {
  it('is done when asked, and answers with the actor and what was compacted', async () => {
    const { admin, params, actor, runner, failures } = await withTalk('## Goal\nRefunds.');
    const done = await admin.call('actors.compact', { params });
    expect(done.actor).toMatchObject({ id: actor.id, status: 'idle', lastTurn: { end: 'ok' } });
    expect(done.compacted).toEqual({
      kind: 'summary',
      atSeq: 5,
      keepFromSeq: 4,
      tokensBefore: 0,
      reason: 'asked',
      createdAt: expect.any(Number) as number,
    });
    // Its model was asked for a summary, with no tools.
    expect(runner.steps.at(-1)).toMatchObject({ tools: [] });
    expect(runner.steps.at(-1)?.instructions).toMatch(/^You are a context summarization/);

    // Nothing is taken out of its conversation: a line says where it was compacted.
    const said = await admin.call('messages.list', { params, query: {} });
    expect(said.items.map((item) => item.message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'system',
    ]);
    expect(JSON.stringify(said.items.at(-1)?.message)).toContain('<compacted/>');
    expect(failures).toEqual([]);
  });

  it('answers with nothing compacted when nothing was said since the last time', async () => {
    const { admin, params } = await withTalk('## Goal\nRefunds.');
    expect((await admin.call('actors.compact', { params })).compacted).not.toBeNull();
    expect((await admin.call('actors.compact', { params })).compacted).toBeNull();
    expect((await admin.call('actors.compactions', { params })).items).toHaveLength(1);
  });

  it('is listed with the actor’s other compactions, the newest first', async () => {
    const { admin, params, say, actor } = await withTalk(
      '## Goal\nRefunds.',
      'You are welcome.',
      '## Goal\nRefunds, and thanks.',
    );
    expect((await admin.call('actors.compactions', { params })).items).toEqual([]);
    await admin.call('actors.compact', { params });
    await say(actor.id, 'Thanks.');
    await admin.call('actors.compact', { params });
    const { items } = await admin.call('actors.compactions', { params });
    expect(items.map((item) => [item.kind, item.reason, item.atSeq])).toEqual([
      ['summary', 'asked', 8],
      ['summary', 'asked', 5],
    ]);
  });

  it('is counted apart from the turns, in what the models were used for', async () => {
    const { admin, params } = await withTalk('## Goal\nRefunds.');
    await admin.call('actors.compact', { params });
    const calls = async (kind?: 'turn' | 'compaction') =>
      (await admin.call('usage.get', { query: kind === undefined ? {} : { kind } })).totals.calls;
    expect(await calls('compaction')).toBe(1);
    expect(await calls('turn')).toBe(2);
    expect(await calls()).toBe(3);
    expect(await refusal(admin.call('usage.get', { query: { kind: 'other' as never } }))).toEqual({
      code: 'invalid_request',
      status: 400,
    });
  });

  it('is refused while the actor is in a turn', async () => {
    const { admin, deploy, engine } = await api([() => new Promise(() => {})]);
    const { agent } = await deploy('orders', 'orders@small');
    const { actor } = await admin.call('actors.create', { params: { agent: agent.id }, body: {} });
    const params = { actor: actor.id };
    await admin.call('inputs.send', { params, body: { type: 'message', payload: { text: 'Hi' } } });
    await expect
      .poll(async () => (await admin.call('actors.get', { params })).status)
      .toBe('working');
    expect(await refusal(admin.call('actors.compact', { params }))).toEqual({
      code: 'actor_busy',
      status: 409,
    });
    await engine.close({ graceMs: 0 });
  });

  it('says so when the model fails at it, and leaves the conversation as it was', async () => {
    const { admin, params } = await withTalk(() => {
      throw new ModelFailure('Fake refused the key', 'auth', { provider: 'fake' });
    });
    const failed = await refusal(admin.call('actors.compact', { params }));
    expect(failed).toEqual({ code: 'provider_failed', status: 502 });
    expect((await admin.call('actors.compactions', { params })).items).toEqual([]);
    expect((await admin.call('actors.get', { params })).status).toBe('idle');
  });

  it('takes a key that may change actors to compact, and one that reads them to list', async () => {
    const { keyed, params, deploy } = await withTalk('## Goal\nRefunds.');
    const reader = await keyed({ scope: { type: 'engine' }, permissions: ['actors:read'] });
    expect(await refusal(reader.client.call('actors.compact', { params }))).toEqual({
      code: 'forbidden',
      status: 403,
    });
    expect((await reader.client.call('actors.compactions', { params })).items).toEqual([]);
    const writer = await keyed({ scope: { type: 'engine' }, permissions: ['actors:write'] });
    expect((await writer.client.call('actors.compact', { params })).compacted).not.toBeNull();
    expect(await refusal(writer.client.call('actors.compactions', { params }))).toEqual({
      code: 'forbidden',
      status: 403,
    });
    // A key for another agent does not reach this actor.
    const billing = await deploy('billing', 'billing@1');
    const ofOther = await keyed({
      scope: { type: 'agent', agent: billing.agent.id },
      permissions: ['actors:read', 'actors:write'],
    });
    expect(await refusal(ofOther.client.call('actors.compact', { params }))).toEqual({
      code: 'not_found',
      status: 404,
    });
    expect(await refusal(ofOther.client.call('actors.compactions', { params }))).toEqual({
      code: 'not_found',
      status: 404,
    });
  });
});
