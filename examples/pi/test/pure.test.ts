// The pure helpers on their own: errors, tool arguments, the system prompt.

import { describe, expect, it } from 'vitest';

import {
  isContextOverflow,
  isRetryable,
  prepareToolArguments,
  retryDelayMs,
  systemPrompt,
} from '../src/index.js';
import { call, failure, reply, usage } from './helpers.js';

describe('errors', () => {
  it('recognises context overflows, and not rate limits', () => {
    expect(
      isContextOverflow(failure('prompt is too long: 213462 tokens > 200000 maximum'), 200_000),
    ).toBe(true);
    expect(
      isContextOverflow(failure('Your input exceeds the context window of this model'), 200_000),
    ).toBe(true);
    expect(
      isContextOverflow(failure('ThrottlingException: Too many tokens, rate limit'), 200_000),
    ).toBe(false);
    const truncated = reply([], 'length', {
      usage: { ...usage(200_000, 0), input: 199_000, output: 0 },
    });
    expect(isContextOverflow(truncated, 200_000)).toBe(true);
  });

  it('retries passing errors only', () => {
    expect(isRetryable(failure('529 overloaded_error'))).toBe(true);
    expect(isRetryable(failure('socket hang up'))).toBe(true);
    expect(isRetryable(failure('400 invalid request'))).toBe(false);
    expect(isRetryable(failure('insufficient_quota'))).toBe(false);
  });

  it('doubles the delay up to the cap', () => {
    const retry = { enabled: true, maxRetries: 9, baseDelayMs: 2_000, maxDelayMs: 60_000 };
    expect([1, 2, 3, 6].map((attempt) => retryDelayMs(retry, attempt))).toEqual([
      2_000, 4_000, 8_000, 60_000,
    ]);
  });
});

describe('tool arguments', () => {
  it('converts numbers given as strings, as pi does', () => {
    expect(prepareToolArguments(call('c', 'read', { path: 'a', offset: '5' }))).toEqual({
      args: { path: 'a', offset: 5 },
    });
  });

  it('repairs the edit shapes models get wrong', () => {
    const edits = [{ oldText: 'a', newText: 'b' }];
    expect(
      prepareToolArguments(call('c', 'edit', { path: 'f', edits: JSON.stringify(edits) })),
    ).toEqual({
      args: { path: 'f', edits },
    });
    expect(
      prepareToolArguments(call('c', 'edit', { path: 'f', oldText: 'a', newText: 'b' })),
    ).toEqual({
      args: { path: 'f', edits },
    });
  });

  it('reports malformed arguments from the model', () => {
    const block = { ...call('c', 'bash', {}), argumentsError: 'Unexpected end of JSON input' };
    expect(prepareToolArguments(block)).toEqual({
      error: 'Invalid arguments for tool "bash": Unexpected end of JSON input',
    });
  });
});

describe('system prompt', () => {
  it("is pi's default prompt for the four tools and the working directory", () => {
    const prompt = systemPrompt('/repo');
    expect(prompt.startsWith('You are an expert coding assistant operating inside pi')).toBe(true);
    expect(prompt).toContain('- read: Read file contents');
    expect(prompt).toContain('- Use bash for file operations like ls, rg, find');
    expect(prompt.endsWith('<cwd>\n/repo\n</cwd>')).toBe(true);
  });
});
