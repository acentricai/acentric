import { describe, expect, it } from 'vitest';

import { calls, says } from '../src/fakes.ts';
import { StaleEpoch } from '../src/interfaces.ts';
import type { ModelAnswer } from '../src/interfaces.ts';
import { HANDLER, LOOKUP, deferred, eventually, world } from './world.ts';

const lookup = calls({ id: 'c1', name: 'lookup_order', arguments: { id: 4411 } });

describe('one turn, on fake parts', () => {
  it('takes a message, calls the model, runs its tool, and ends with its answer', async () => {
    const { store, engine } = world();
    const one = engine([lookup, says('It was refunded twice.')]);
    const actor = await one.createActor();
    one.follow(actor.id);

    const sent = await one.it.send(actor.id, {
      type: 'message',
      payload: { text: 'Why two refunds?' },
    });
    await one.it.settled(actor.id);

    expect(sent.status).toBe('accepted');
    const conversation = await store.conversation(actor.id);
    expect(conversation.map((entry) => [entry.seq, entry.message.role])).toEqual([
      [1, 'user'],
      [2, 'assistant'],
      [3, 'tool_result'],
      [4, 'assistant'],
    ]);
    expect(conversation[0]?.input).toEqual({ id: sent.input, type: 'message' });
    expect(conversation[1]?.completion?.stopReason).toBe('tool_use');
    expect(conversation[2]?.message).toMatchObject({
      toolCallId: 'c1',
      isError: false,
      content: [{ type: 'text', text: 'Order 4411 was refunded twice.' }],
    });

    const record = await store.loadActor(actor.id);
    expect(record?.turn).toEqual({ phase: 'idle' });
    expect(record?.actor).toMatchObject({
      status: 'idle',
      pendingInputs: 0,
      lastTurn: { end: 'ok' },
    });
    expect(one.it.failures).toEqual([]);
  });

  it('calls the model with the definition and the conversation so far', async () => {
    const { engine } = world();
    const one = engine([lookup, says('It was refunded twice.')]);
    const actor = await one.createActor();
    await one.it.send(actor.id, { type: 'message', payload: { text: 'Why two refunds?' } });
    await one.it.settled(actor.id);

    expect(one.runner.steps).toHaveLength(2);
    expect(one.runner.steps[0]).toMatchObject({
      model: 'fake-1',
      instructions: 'You answer questions about orders.',
      tools: [{ type: 'function', name: 'lookup_order' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Why two refunds?' }] }],
    });
    expect(one.runner.steps[1]?.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool_result',
    ]);
    expect(one.executor.made).toEqual([
      { path: HANDLER, argument: { text: 'Why two refunds?' } },
      { path: LOOKUP, argument: { id: 4411 } },
    ]);
  });

  it('tells whoever follows it each message once it is stored, and where it stands', async () => {
    const { engine } = world();
    const one = engine([lookup, says('It was refunded twice.')]);
    const actor = await one.createActor();
    one.follow(actor.id);
    await one.it.send(actor.id, { type: 'message', payload: { text: 'Why two refunds?' } });
    await one.it.settled(actor.id);

    expect(one.events.map((event) => event.type)).toEqual([
      'message',
      'status',
      'message',
      'message',
      'message',
      'status',
    ]);
    expect(one.events[1]).toMatchObject({ type: 'status', status: 'working', pendingInputs: 0 });
    // Told the actor is idle, a follower has every message of the turn that ended.
    expect(one.events.at(-1)).toMatchObject({
      type: 'status',
      status: 'idle',
      lastTurn: { end: 'ok' },
    });
  });

  it('stores five times for a turn of two model calls and one tool call', async () => {
    const { store, engine } = world();
    const one = engine([lookup, says('It was refunded twice.')]);
    const actor = await one.createActor();
    await one.it.send(actor.id, { type: 'message', payload: { text: 'Why two refunds?' } });
    await one.it.settled(actor.id);

    // The mail taken, the first answer, the tool's result, the return to the model, the last answer.
    expect(store.commits).toBe(5);
  });

  it('ends the turn as failed when the call of the model fails', async () => {
    const { store, engine } = world();
    const one = engine([
      () => {
        throw new Error('overloaded');
      },
    ]);
    const actor = await one.createActor();
    await one.it.send(actor.id, { type: 'message', payload: { text: 'Hello?' } });
    await one.it.settled(actor.id);

    const record = await store.loadActor(actor.id);
    expect(record?.actor).toMatchObject({
      status: 'idle',
      lastTurn: { end: 'failed', reason: 'overloaded' },
    });
    expect((await store.conversation(actor.id)).map((entry) => entry.message.role)).toEqual([
      'user',
    ]);
  });
});

describe('mail', () => {
  it('that comes while a tool runs joins the turn when it goes back to the model', async () => {
    const gate = deferred<string>();
    const { store, engine } = world();
    const one = engine([lookup, says('Both answered.')], () => gate.promise);
    const actor = await one.createActor();

    await one.it.send(actor.id, { type: 'message', payload: { text: 'Why two refunds?' } });
    await eventually(() => one.executor.made.some((call) => call.path === LOOKUP));
    await one.it.send(actor.id, { type: 'message', payload: { text: 'And was it in the EU?' } });
    gate.resolve('Order 4411 was refunded twice.');
    await one.it.settled(actor.id);

    expect((await store.conversation(actor.id)).map((entry) => entry.message.role)).toEqual([
      'user',
      'assistant',
      'tool_result',
      'user',
      'assistant',
    ]);
    // One turn: the second message started no turn of its own.
    expect(one.runner.steps).toHaveLength(2);
  });

  it('that comes during the last call of the model starts another turn', async () => {
    const { store, engine } = world();
    const one = engine([
      async () => {
        await one.it.send(actor.id, { type: 'message', payload: { text: 'One more thing.' } });
        return says('First answer.');
      },
      says('Second answer.'),
    ]);
    const actor = await one.createActor();
    await one.it.send(actor.id, { type: 'message', payload: { text: 'Hello.' } });
    await one.it.settled(actor.id);

    expect((await store.conversation(actor.id)).map((entry) => entry.message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect((await store.loadActor(actor.id))?.actor.pendingInputs).toBe(0);
  });

  it('sent twice with one external ID is stored once', async () => {
    const { store, engine } = world();
    const one = engine([says('Hello.')]);
    const actor = await one.createActor();
    const message = { type: 'message', payload: { text: 'Hello.' }, externalId: 'update-9' };

    const first = await one.it.send(actor.id, message);
    const second = await one.it.send(actor.id, message);
    await one.it.settled(actor.id);

    expect([first.status, second.status]).toEqual(['accepted', 'duplicate']);
    expect((await store.conversation(actor.id)).map((entry) => entry.message.role)).toEqual([
      'user',
      'assistant',
    ]);
  });
});

describe('a restart', () => {
  it('in a call of the model: another process makes the call again, and the first is shut out', async () => {
    const hung = deferred<ModelAnswer>();
    const { store, engine } = world();
    const first = engine([() => hung.promise]);
    const actor = await first.createActor();
    await first.it.send(actor.id, { type: 'message', payload: { text: 'Hello.' } });
    await eventually(async () => (await store.loadActor(actor.id))?.turn.phase === 'model');

    // The first process is gone, as far as anything can tell. A second starts on the same store.
    const second = engine([says('Hello.')]);
    await second.it.recover();
    await second.it.settled(actor.id);

    const roles = async () =>
      (await store.conversation(actor.id)).map((entry) => entry.message.role);
    expect(await roles()).toEqual(['user', 'assistant']);
    expect((await store.loadActor(actor.id))?.actor.lastTurn?.end).toBe('ok');

    // The first process was not gone after all, and its call comes back. It may store nothing.
    hung.resolve(says('Late.'));
    await first.it.settled(actor.id);
    expect(first.it.failures).toHaveLength(1);
    expect(first.it.failures[0]).toBeInstanceOf(StaleEpoch);
    expect(await roles()).toEqual(['user', 'assistant']);
  });

  it('in a tool that is not safe to call again: the model is told it may or may not have run', async () => {
    const { store, engine } = world({ retrySafe: false });
    const first = engine([lookup], () => new Promise<string>(() => {}));
    const actor = await first.createActor();
    await first.it.send(actor.id, { type: 'message', payload: { text: 'Why two refunds?' } });
    await eventually(() => first.executor.made.some((call) => call.path === LOOKUP));

    const second = engine([says('I could not confirm it.')]);
    await second.it.recover();
    await second.it.settled(actor.id);

    expect(second.executor.made).toEqual([]);
    const conversation = await store.conversation(actor.id);
    expect(conversation.map((entry) => entry.message.role)).toEqual([
      'user',
      'assistant',
      'tool_result',
      'assistant',
    ]);
    expect(conversation[2]?.message).toMatchObject({
      isError: true,
      content: [
        { type: 'text', text: expect.stringContaining('may or may not have run') as string },
      ],
    });
  });

  it('in a tool that is safe to call again: it is called again', async () => {
    const { store, engine } = world({ retrySafe: true });
    const first = engine([lookup], () => new Promise<string>(() => {}));
    const actor = await first.createActor();
    await first.it.send(actor.id, { type: 'message', payload: { text: 'Why two refunds?' } });
    await eventually(() => first.executor.made.some((call) => call.path === LOOKUP));

    const second = engine([says('It was refunded twice.')]);
    await second.it.recover();
    await second.it.settled(actor.id);

    expect(second.executor.made).toEqual([{ path: LOOKUP, argument: { id: 4411 } }]);
    expect((await store.conversation(actor.id))[2]?.message).toMatchObject({ isError: false });
  });
});
