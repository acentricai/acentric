// Tasks, through the API: work an actor's model started is listed, read and stopped, and an
// actor is aborted with all of it.

import { describe, expect, it } from 'vitest';

import { calls, says } from '@acentric/ai/testing';
import type { TaskEnd, TaskKind } from '@acentric/core';

import { api, refusal } from './api.ts';

/** A kind of task whose work goes on until a test ends it, or it is stopped. */
function jobs() {
  const under = new Map<string, (end: TaskEnd) => void>();
  const kind: TaskKind = {
    kind: 'job',
    prefix: 'j',
    tool: {
      name: 'job',
      description: 'Starts a job.',
      properties: { what: { type: 'string' } },
      required: ['what'],
    },
    input: (args) => ({ what: String(args['what']) }),
    run: (task, { stop, closing }) =>
      new Promise<TaskEnd>((resolve) => {
        under.set(task.id, resolve);
        stop.addEventListener('abort', () => {
          resolve({ status: 'done', text: 'partial output' });
        });
        closing.addEventListener('abort', () => {
          resolve({ status: 'done', text: '' });
        });
      }),
  };
  return { kind, end: (id: string, text: string) => under.get(id)?.({ status: 'done', text }) };
}

const job = (id: string, args: { [name: string]: string | number }) =>
  calls({ id, name: 'job', arguments: args });

describe('an actor’s tasks', () => {
  it('are listed newest first, read with what they came to, and stopped', async () => {
    const work = jobs();
    const one = await api(
      [
        calls(
          { id: 'c1', name: 'job', arguments: { what: 'a', wait: 0 } },
          { id: 'c2', name: 'job', arguments: { what: 'b', wait: 0 } },
        ),
        says('Both are running.'),
        says('One has ended.'),
        says('The other was stopped.'),
      ],
      { kinds: [work.kind] },
    );
    const { admin, deploy, say, engine, failures } = one;
    const { agent } = await deploy();
    const { actor } = await admin.call('actors.create', { params: { agent: agent.id }, body: {} });
    const params = { actor: actor.id };
    await say(actor.id, 'Do both.');

    const listed = await admin.call('tasks.list', { params });
    expect(listed.items).toMatchObject([
      { id: 'j2', kind: 'job', status: 'running', attached: false },
      { id: 'j1', kind: 'job', status: 'running', attached: false },
    ]);
    expect(await admin.call('tasks.get', { params: { ...params, task: 'j1' } })).toMatchObject({
      id: 'j1',
      input: { what: 'a' },
      result: null,
    });

    work.end('j1', 'the output of a');
    await expect
      .poll(
        async () => (await admin.call('tasks.list', { params, query: { running: true } })).items,
      )
      .toHaveLength(1);
    expect(await admin.call('tasks.get', { params: { ...params, task: 'j1' } })).toMatchObject({
      status: 'done',
      result: 'the output of a',
    });

    // Stopped by a person, it answers once it has ended.
    const stopped = await admin.call('tasks.stop', { params: { ...params, task: 'j2' } });
    expect(stopped).toMatchObject({ id: 'j2', status: 'stopped', stoppedBy: 'person' });
    expect(stopped.endedAt).toBeGreaterThanOrEqual(stopped.startedAt);
    await engine.settled(actor.id);
    await expect
      .poll(async () => (await admin.call('messages.list', { params })).items.length)
      .toBe(9);
    await engine.settled(actor.id);
    // Each ending reached the model as a line of the engine's own.
    const { items } = await admin.call('messages.list', { params });
    expect(items.map((entry) => entry.message.role)).toEqual([
      'user',
      'assistant',
      'tool_result',
      'tool_result',
      'assistant',
      'system',
      'assistant',
      'system',
      'assistant',
    ]);
    expect(failures).toEqual([]);
    await engine.close();
  });

  it('are there for those who may read their actor, and stopped by those who may stop it', async () => {
    const work = jobs();
    const one = await api([job('c1', { what: 'a', wait: 0 }), says('Running.')], {
      kinds: [work.kind],
    });
    const { admin, deploy, say, keyed, engine } = one;
    const { agent } = await deploy();
    const { actor } = await admin.call('actors.create', { params: { agent: agent.id }, body: {} });
    const other = await admin.call('actors.create', { params: { agent: agent.id }, body: {} });
    await say(actor.id, 'Do a.');
    const task = { actor: actor.id, task: 'j1' };
    const notFound = { code: 'not_found', status: 404 };

    // An actor has no task of another's, and none of an ID nothing has.
    expect(
      await refusal(admin.call('tasks.get', { params: { actor: other.actor.id, task: 'j1' } })),
    ).toEqual(notFound);
    expect(await refusal(admin.call('tasks.get', { params: { ...task, task: 'j9' } }))).toEqual(
      notFound,
    );
    expect(await refusal(admin.call('tasks.stop', { params: { ...task, task: 'j9' } }))).toEqual(
      notFound,
    );
    expect(
      await refusal(admin.call('tasks.get', { params: { ...task, task: 'not a task' } })),
    ).toEqual({ code: 'invalid_request', status: 400 });

    const reader = await keyed({
      scope: { type: 'actor', actor: actor.id },
      permissions: ['actors:read'],
    });
    expect(
      (await reader.client.call('tasks.list', { params: { actor: actor.id } })).items,
    ).toHaveLength(1);
    expect(await refusal(reader.client.call('tasks.stop', { params: task }))).toEqual({
      code: 'forbidden',
      status: 403,
    });
    expect(
      await refusal(reader.client.call('tasks.list', { params: { actor: other.actor.id } })),
    ).toEqual(notFound);
    const stopper = await keyed({
      scope: { type: 'actor', actor: actor.id },
      permissions: ['actors:stop'],
    });
    expect((await stopper.client.call('tasks.stop', { params: task })).status).toBe('stopped');
    await engine.close();
  });
});

describe('an actor that is aborted', () => {
  it('has its turn and its tasks stopped, and what waited starts no turn', async () => {
    const work = jobs();
    const one = await api(
      [
        calls(
          { id: 'c1', name: 'job', arguments: { what: 'a', wait: 0 } },
          { id: 'c2', name: 'job', arguments: { what: 'b' } },
        ),
        says('I am back.'),
      ],
      { kinds: [work.kind] },
    );
    const { admin, deploy, engine, keyed } = one;
    const { agent } = await deploy();
    const { actor } = await admin.call('actors.create', { params: { agent: agent.id }, body: {} });
    const params = { actor: actor.id };
    await admin.call('inputs.send', {
      params,
      body: { type: 'message', payload: { text: 'Do both.' } },
    });
    await expect
      .poll(async () => (await admin.call('tasks.list', { params })).items.length)
      .toBe(2);

    const reader = await keyed({ scope: { type: 'engine' }, permissions: ['actors:read'] });
    expect(await refusal(reader.client.call('actors.abort', { params }))).toEqual({
      code: 'forbidden',
      status: 403,
    });

    const aborted = await admin.call('actors.abort', { params });
    expect(aborted).toMatchObject({
      interrupted: true,
      actor: { id: actor.id, status: 'idle', lastTurn: { end: 'interrupted' } },
    });
    expect(aborted.tasks.map((task) => [task.id, task.status, task.stoppedBy])).toEqual([
      ['j1', 'stopped', 'abort'],
      ['j2', 'stopped', 'abort'],
    ]);
    // Their endings wait, quietly, for a turn that something new starts.
    await engine.settled(actor.id);
    const waiting = await admin.call('inputs.list', { params, query: { pending: true } });
    expect(waiting.items.map((input) => [input.type, input.quiet])).toEqual([
      ['notice', true],
      ['notice', true],
    ]);
    expect((await admin.call('actors.get', { params })).status).toBe('idle');

    await admin.call('inputs.send', {
      params,
      body: { type: 'message', payload: { text: 'Hello?' } },
    });
    await engine.settled(actor.id);
    const { items } = await admin.call('messages.list', { params });
    expect(items.slice(4).map((entry) => entry.message.role)).toEqual([
      'system',
      'system',
      'user',
      'assistant',
    ]);
    await engine.close();
  });
});
