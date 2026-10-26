import type { Agent, Handlers, JsonObject, Outcome } from '@acentric/types';
import { createMemoryRunner } from '@acentric/runner-memory';
import { describe, expect, it } from 'vitest';

import { isLlmFailure, LLM_FAILURE_KINDS, LlmError, llmFailure } from '../src/index.js';
import type { LlmFailure } from '../src/index.js';

describe('LlmError', () => {
  it('defaults retryable by kind, and keeps only the details given', () => {
    const throttled = new LlmError('slow down', {
      kind: 'rate_limited',
      provider: 'anthropic',
      retryAfterMs: 3000,
      httpStatus: 429,
    });
    expect(throttled.retryable).toBe(true);
    expect(throttled.toJSON()).toEqual({
      name: 'LlmError',
      message: 'slow down',
      kind: 'rate_limited',
      retryable: true,
      provider: 'anthropic',
      retryAfterMs: 3000,
      httpStatus: 429,
    });
    expect(new LlmError('no', { kind: 'auth' }).retryable).toBe(false);
    expect(new LlmError('again', { kind: 'auth', retryable: true }).retryable).toBe(true);
  });

  it('comes back from its Json unchanged', () => {
    const error = new LlmError('gone', {
      kind: 'not_found',
      providerParam: 'previous_response_id',
    });
    const back = LlmError.fromJSON(error.toJSON());
    expect(back).toBeInstanceOf(LlmError);
    expect(back.toJSON()).toEqual(error.toJSON());
  });

  it('knows every kind', () => {
    expect(LLM_FAILURE_KINDS).toContain('context_overflow');
    expect(LLM_FAILURE_KINDS).toHaveLength(14);
  });
});

describe('llmFailure', () => {
  it('reads an LLM failure from an outcome, and nothing else', () => {
    const failure = new LlmError('long', { kind: 'context_overflow' }).toJSON();
    expect(llmFailure({ failed: { code: 'threw', error: failure } })).toEqual(failure);
    expect(llmFailure({ ok: failure })).toBeNull();
    expect(llmFailure({ failed: { code: 'timeout', error: { timeoutMs: 5 } } })).toBeNull();
    expect(
      llmFailure({ failed: { code: 'threw', error: { name: 'Error', message: 'x' } } }),
    ).toBeNull();
    expect(llmFailure({ interrupted: true })).toBeNull();
    expect(isLlmFailure({ ...failure, kind: 'made_up' })).toBe(false);
  });

  it('reaches step through a runner, which reports what toJSON() returns', async () => {
    type Snapshot = { failure: LlmFailure | null; done: boolean };
    const agent: Agent<Snapshot> = {
      name: 'caller',
      version: '1',
      kinds: ['complete'],
      init: () => ({ snapshot: { failure: null, done: false } }),
      step: ({ snapshot }, message) => {
        if (message.type !== 'effect') return { snapshot };
        const outcome: Outcome = message.outcome;
        return { snapshot: { failure: llmFailure(outcome), done: true } };
      },
      effects: ({ snapshot }) =>
        snapshot.done ? [] : [{ key: 'call:1', kind: 'complete', args: null }],
    };
    const handlers: Handlers = {
      complete: {
        mode: 'reissue',
        run: () =>
          Promise.reject(new LlmError('slow down', { kind: 'rate_limited', retryAfterMs: 3000 })),
      },
    };
    const runner = createMemoryRunner();
    const { id } = runner.create(runner.load(agent, handlers), {});
    if (id === undefined) throw new Error('not created');
    const snapshot = await until(
      () => runner.snapshot(id),
      (s) => s['done'] === true,
    );
    expect(snapshot['failure']).toMatchObject({
      name: 'LlmError',
      kind: 'rate_limited',
      retryable: true,
      retryAfterMs: 3000,
    });
    runner.close();
  });
});

async function until(
  read: () => JsonObject,
  done: (value: JsonObject) => boolean,
): Promise<JsonObject> {
  for (let tries = 0; tries < 100; tries += 1) {
    const value = read();
    if (done(value)) return value;
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the runner did not settle');
}
