// The handlers on their own: model calls against pi-ai's faux provider, and
// the tools against a temporary directory. The model call is also checked
// end to end with the pure half, through the simulator.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handlerContext } from '@acentric/testing';
import type { LogEntry } from '@acentric/types';
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from '@earendil-works/pi-ai';
import type { Context } from '@earendil-works/pi-ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fromPiAssistant, toPiMessages } from '../src/handlers/convert.js';
import { llmHandler, summarizeHandler } from '../src/handlers/llm.js';
import { toolHandler } from '../src/handlers/tools.js';
import type { AssistantMessage, LlmArgs, ToolCallRef } from '../src/index.js';
import { call, keyOf, reply, start, text } from './helpers.js';

const SECRETS = { ANTHROPIC_API_KEY: 'test-key' };

/** Models whose 'anthropic' provider answers with scripted replies. */
function scriptedModels() {
  const faux = fauxProvider({
    provider: 'anthropic',
    models: [{ id: 'claude-sonnet-5-5', reasoning: true }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, faux };
}

describe('llm handler', () => {
  it('sends the system prompt, the conversation and the tools, and returns the reply', async () => {
    const { models, faux } = scriptedModels();
    let seen: Context | undefined;
    faux.setResponses([
      (context) => {
        seen = context;
        return fauxAssistantMessage([fauxText('hello there')]);
      },
    ]);

    const sim = start();
    sim.input('prompt', { text: 'hi' });
    const [request] = sim.effectsOf('llm');
    if (request === undefined) throw new Error('no llm effect');

    const { ctx, emitted } = handlerContext({ args: request.args, log: sim.log, secrets: SECRETS });
    const result = await llmHandler(models).run(ctx);

    expect(result.stopReason).toBe('stop');
    expect(result.content).toEqual([text('hello there')]);
    expect(emitted.length).toBeGreaterThan(0);
    expect(JSON.stringify(seen)).toContain('You are an expert coding assistant');
    expect(JSON.stringify(seen)).toContain('"name":"bash"');
    expect(JSON.stringify(seen)).toContain('hi');

    // The reply goes back to the pure half like any effect result.
    sim.ok(request.key, result);
    expect(sim.snapshot.phase.kind).toBe('idle');
  });

  it('fails when the API key is missing', async () => {
    const { models } = scriptedModels();
    const args: LlmArgs = {
      model: { provider: 'anthropic', id: 'claude-sonnet-5-5' },
      thinkingLevel: 'off',
      cwd: '/repo',
      compactionSeq: null,
      fromSeq: 1,
      toSeq: 1,
    };
    const { ctx } = handlerContext({ args });
    await expect(llmHandler(models).run(ctx)).rejects.toThrow(
      'secret ANTHROPIC_API_KEY is not set',
    );
  });
});

describe('summarize handler', () => {
  it("summarises the range with pi's prompt and returns the text and usage", async () => {
    const { models, faux } = scriptedModels();
    let prompt = '';
    faux.setResponses([
      (context) => {
        prompt = JSON.stringify(context.messages);
        return fauxAssistantMessage([fauxText('## Goal\nSay hi')]);
      },
    ]);

    const sim = start({ compaction: { keepRecentTokens: 1 } });
    sim.input('prompt', { text: 'first task' });
    sim.ok(keyOf(sim, 'llm'), reply([text('done')]));
    sim.input('prompt', { text: 'second task' });
    sim.ok(keyOf(sim, 'llm'), reply([text('done again')]));
    sim.input('compact', {});
    const [request] = sim.effectsOf('summarize');
    if (request === undefined) throw new Error('no summarize effect');

    const { ctx } = handlerContext({ args: request.args, log: sim.log, secrets: SECRETS });
    const result = await summarizeHandler(models).run(ctx);

    expect(result.summary).toBe('## Goal\nSay hi');
    // The cut keeps only the last reply; everything before it is summarised.
    expect(prompt).toContain('[User]: first task');
    expect(prompt).toContain('[User]: second task');
    expect(prompt).not.toContain('done again');
    sim.ok(request.key, result);
    expect(sim.snapshot.compaction).not.toBeNull();
  });
});

describe('tool handlers', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pi-tools-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A log with one reply calling `name`, and the args for running that call. */
  function toolCall(
    name: string,
    args: Record<string, unknown>,
  ): { log: LogEntry[]; args: ToolCallRef } {
    const message: AssistantMessage = reply([call('c1', name, JSON.parse(JSON.stringify(args)))]);
    return {
      log: [{ seq: 1, at: 0, kind: 'assistant', body: { ...message, thinkingLevel: 'off' } }],
      args: { seq: 1, toolCallId: 'c1', cwd: dir },
    };
  }

  it('writes, reads and edits a file as pi does', async () => {
    const write = toolCall('write', { path: 'notes/a.txt', content: 'one\ntwo\n' });
    const written = await toolHandler('write').run(handlerContext(write).ctx);
    expect(written).toMatchObject({ isError: false });
    expect(await readFile(join(dir, 'notes/a.txt'), 'utf8')).toBe('one\ntwo\n');

    const read = await toolHandler('read').run(
      handlerContext(toolCall('read', { path: 'notes/a.txt' })).ctx,
    );
    expect(read.content).toEqual([text('one\ntwo\n')]);

    const edit = toolCall('edit', {
      path: 'notes/a.txt',
      edits: [{ oldText: 'two', newText: 'three' }],
    });
    const edited = await toolHandler('edit').run(handlerContext(edit).ctx);
    expect(edited.isError).toBe(false);
    expect(edited.details).toHaveProperty('diff');
    expect(await readFile(join(dir, 'notes/a.txt'), 'utf8')).toBe('one\nthree\n');
  });

  it("reports pi's error when an edit does not match", async () => {
    await writeFile(join(dir, 'a.txt'), 'x\n');
    const edit = toolCall('edit', { path: 'a.txt', edits: [{ oldText: 'missing', newText: 'y' }] });
    const result = await toolHandler('edit').run(handlerContext(edit).ctx);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Could not find the exact text');
  });

  it('runs a command, streaming its output', async () => {
    const { ctx, emitted } = handlerContext(toolCall('bash', { command: 'echo hello' }));
    const result = await toolHandler('bash').run(ctx);
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.content)).toContain('hello');
    expect(emitted.length).toBeGreaterThan(0);
  });

  it('keeps what an aborted command printed', async () => {
    const { ctx, controller } = handlerContext(
      toolCall('bash', { command: 'echo started; sleep 5' }),
    );
    const running = toolHandler('bash').run(ctx);
    setTimeout(() => controller.abort(), 300);
    const result = await running;
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('started');
    expect(JSON.stringify(result.content)).toContain('aborted');
  });
});

describe('converting messages', () => {
  it('keeps what a provider needs to accept its earlier replies', () => {
    const block = {
      type: 'toolCall' as const,
      id: 'call_1|fc_1',
      name: 'bash',
      arguments: { command: 'ls' },
      thoughtSignature: 'sig',
      namespace: 'functions',
    };
    const message = fromPiAssistant({
      role: 'assistant',
      content: [block],
      api: 'openai-responses',
      provider: 'openai',
      model: 'gpt-5.4-mini',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'toolUse',
      timestamp: 0,
    });
    expect(message.content).toEqual([block]);
    const [replayed] = toPiMessages([{ role: 'assistant', thinkingLevel: 'low', ...message }]);
    expect(replayed).toMatchObject({ content: [block] });
  });
});
