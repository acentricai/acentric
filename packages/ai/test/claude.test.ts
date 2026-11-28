// The Claude provider, on a stand-in of the Claude Agent SDK and of Claude Code: a session for
// each conversation, the engine's tools handed over and their results handed back, sessions
// stopped and resumed where the engine's conversation is, and how failures read.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { JsonObject, Message } from '@acentric/protocol';

import { ModelFailure } from '../src/failure.ts';
import type { Provider } from '../src/provider.ts';
import { claudeProvider } from '../src/providers/claude/index.ts';
import type { ModelAnswer, ModelStep } from '../src/runner.ts';
import { fakeProgram, fakeSdk, memoryLogs } from './fake-claude.ts';
import type { Scripted } from './fake-claude.ts';

const LOOKUP = {
  type: 'function' as const,
  name: 'lookup_order',
  description: 'Finds an order.',
  parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
};

const said = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });
const text = (value: string): Scripted => ({ content: [{ type: 'text', text: value }] });
const call = (id: string): Scripted => ({
  content: [{ type: 'tool_use', id, name: 'lookup_order', input: { id: 7 } }],
  stop: 'tool_use',
});
const result = (id: string, value: string): Message => ({
  role: 'tool_result',
  toolCallId: id,
  toolName: 'lookup_order',
  content: [{ type: 'text', text: value }],
});

const providers: Provider[] = [];
afterEach(async () => {
  for (const provider of providers.splice(0)) await provider.close?.();
});

function setup(
  script: Scripted[],
  more: {
    idleMs?: number;
    maxSessions?: number;
    /** Those of a server before this one: a restart. */
    after?: {
      readonly binary: string;
      readonly dir: string;
      readonly logs: ReturnType<typeof memoryLogs>;
    };
  } = {},
) {
  const { binary, dir } = more.after ?? fakeProgram();
  const sdk = fakeSdk(script);
  const logs = more.after?.logs ?? memoryLogs();
  const reports: string[] = [];
  const provider = claudeProvider({
    sdk,
    binary,
    home: dir,
    env: { PATH: process.env['PATH'], ANTHROPIC_API_KEY: 'sk-of-the-host', TZ: 'UTC' },
    idleMs: more.idleMs ?? 60_000,
    maxSessions: more.maxSessions ?? 4,
    report: (line) => reports.push(line),
  });
  providers.push(provider);
  const runner = provider.runner({ credential: { type: 'local_sign_in', home: 'acct-1' }, logs });
  const signal = new AbortController().signal;
  const step = (messages: readonly Message[], changes: Partial<ModelStep> = {}): ModelStep => ({
    model: 'claude-sonnet-5-5',
    reasoning: 'high',
    instructions: 'Be brief.',
    tools: [LOOKUP],
    messages,
    session: 'act_1',
    compactAt: 800_000,
    ...changes,
  });
  const run = (messages: readonly Message[], changes: Partial<ModelStep> = {}) =>
    runner.run(step(messages, changes), signal);
  return { provider, runner, sdk, logs, dir, binary, reports, run, step, signal };
}

const textOf = (answer: ModelAnswer): string =>
  answer.message.content.map((block) => String(block['text'] ?? '')).join('');

describe('the Claude provider', () => {
  it("answers a conversation's first call in a session of its own, as the step asks", async () => {
    const { run, sdk, logs, dir } = setup([text('Hello there.')]);
    const answer = await run([said('Hi')]);
    expect(textOf(answer)).toBe('Hello there.');
    expect(answer.stopReason).toBe('stop');
    expect(answer.message).toMatchObject({
      provider: 'claude',
      api: 'anthropic-messages',
      model: 'claude-sonnet-5-5',
    });
    // The SDK's ID of the answer's entry: what a session is put back to.
    expect(answer.message.id).toMatch(/^a\d+-0$/);
    expect(answer.usage).toEqual({
      totalInput: 105,
      input: 10,
      output: 7,
      cacheRead: 90,
      cacheWrite: 5,
    });

    const [session] = sdk.sessions;
    const options = session?.options ?? {};
    expect(options['model']).toBe('claude-sonnet-5-5');
    expect(options['effort']).toBe('high');
    const prompt = options['systemPrompt'] as { prompt: string; snapshot: boolean; type: string };
    expect(prompt.type).toBe('custom');
    expect(prompt.snapshot).toBe(false);
    expect(prompt.prompt.startsWith('Be brief.\n\n# What Claude Code adds')).toBe(true);
    // None of Claude Code's own tools, its settings or its files.
    expect(options['tools']).toEqual([]);
    expect(options['settingSources']).toEqual([]);
    expect(options['permissionMode']).toBe('dontAsk');
    expect(options['allowedTools']).toEqual(['lookup_order', 'mcp__engine__lookup_order']);
    expect(options['settings']).toEqual({ autoCompactEnabled: true, autoCompactWindow: 830_000 });
    expect(options['sessionId']).toEqual(expect.any(String));
    expect(options['resume']).toBeUndefined();
    // The account's own Claude Code, and nothing of the host's: no key of Anthropic's.
    const env = options['env'] as { [name: string]: string };
    expect(env['HOME']).toBe(join(dir, 'accounts', 'acct-1'));
    expect(env['CLAUDE_CONFIG_DIR']).toBe(join(dir, 'accounts', 'acct-1'));
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['TZ']).toBe('UTC');
    expect(env['CLAUDE_CODE_SILENT_TURN_REMINDER']).toBe('0');
    expect(env['CLAUDE_AGENT_SDK_MCP_NO_PREFIX']).toBe('1');
    // The session it is is kept in the conversation's log, with its transcript.
    const kept = logs.kept.get('act_1');
    expect(kept?.get('session')).toEqual([{ sessionId: options['sessionId'] }]);
    expect(kept?.get(`transcript/${String(options['sessionId'])}/`)?.length).toBe(2);
  });

  it("lists the engine's tools with their own schemas", async () => {
    const { run, sdk } = setup([text('Done.')]);
    await run([said('Hi')]);
    const servers = sdk.sessions[0]?.options['mcpServers'] as
      { engine: { instance: { connect(t: unknown): Promise<void> } } } | undefined;
    const server = servers?.engine;
    if (server === undefined) throw new Error('The session was given no server');
    // Asked as Claude Code asks, over a transport of the SDK's.
    let reply: JsonObject | undefined;
    let handler: ((message: unknown) => void) | undefined;
    await server.instance.connect({
      set onmessage(next: (message: unknown) => void) {
        handler = next;
      },
      async start() {},
      async send(message: JsonObject) {
        reply = message;
      },
      async close() {},
    });
    handler?.({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reply).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        tools: [
          {
            name: 'lookup_order',
            description: 'Finds an order.',
            inputSchema: LOOKUP.parameters,
            annotations: { readOnlyHint: true },
            _meta: { 'anthropic/alwaysLoad': true, 'anthropic/maxResultSizeChars': 2_000_000 },
          },
        ],
      },
    });
  });

  it("hands the engine the model's tool calls, and their results back to the calls that wait", async () => {
    const { run, sdk } = setup([call('t1'), text('It shipped.')]);
    const first = await run([said('Where is order 7?')]);
    expect(first.stopReason).toBe('tool_use');
    expect(first.toolCalls).toEqual([{ id: 't1', name: 'lookup_order', arguments: { id: 7 } }]);
    const conversation = [
      said('Where is order 7?'),
      first.message,
      result('t1', 'Order 7: shipped.'),
    ];
    const second = await run(conversation);
    expect(textOf(second)).toBe('It shipped.');
    // One session, which got the result as its call's.
    expect(sdk.sessions).toHaveLength(1);
    expect(sdk.sessions[0]?.results).toEqual([
      { id: 't1', result: { content: [{ type: 'text', text: 'Order 7: shipped.' }] } },
    ]);
  });

  it('sends a message that comes while tools run after their results', async () => {
    const { run, sdk } = setup([call('t1'), text('It shipped.'), text('Yes.')]);
    const first = await run([said('Where is order 7?')]);
    await run([
      said('Where is order 7?'),
      first.message,
      result('t1', 'Order 7: shipped.'),
      said('And quickly?'),
    ]);
    // The stand-in reads it once the call that had the results ends; Claude Code, before.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const heard = sdk.sessions[0]?.heard ?? [];
    expect(heard[1]).toMatchObject({
      message: { content: [{ type: 'text', text: 'And quickly?' }] },
      priority: 'next',
    });
  });

  it('resumes a conversation after a restart from its log, with the results its calls got', async () => {
    const before = setup([call('t1')]);
    const first = await before.run([said('Where is order 7?')]);
    await before.provider.close?.();
    // A server started again: the same folder and log, and no session running.
    const after = setup([text('It shipped.')], { after: before });
    const second = await after.run([
      said('Where is order 7?'),
      first.message,
      result('t1', 'Order 7: shipped.'),
    ]);
    expect(textOf(second)).toBe('It shipped.');
    const resumed = after.sdk.sessions[0];
    expect(resumed?.options['resume']).toBe(before.sdk.sessions[0]?.options['sessionId']);
    expect(resumed?.resumedWith?.map((entry) => entry['type'])).toEqual([
      'user',
      'assistant',
      'user',
    ]);
    expect(resumed?.resumedWith?.at(-1)).toMatchObject({
      type: 'user',
      parentUuid: first.message.id,
      message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] },
    });
  });

  it('starts the session again when what it was started with changes, on the same transcript', async () => {
    const { run, sdk } = setup([text('Hello.'), text('Hello again.')]);
    const first = await run([said('Hi')]);
    const second = await run([said('Hi'), first.message, said('Hi again')], {
      instructions: 'Be kind.',
    });
    expect(textOf(second)).toBe('Hello again.');
    expect(sdk.sessions).toHaveLength(2);
    expect(sdk.sessions[0]?.stopped).toBe(true);
    const resumed = sdk.sessions[1];
    expect(resumed?.options['resume']).toBe(sdk.sessions[0]?.options['sessionId']);
    // Put back to the answer the engine has: nothing after it, and only what is new is said.
    expect(resumed?.resumedWith?.at(-1)?.['uuid']).toBe(first.message.id);
    expect(resumed?.heard.map((one) => one.message.content)).toEqual([
      [{ type: 'text', text: 'Hi again' }],
    ]);
    const prompt = resumed?.options['systemPrompt'] as { prompt: string } | undefined;
    expect(prompt?.prompt).toMatch(/^Be kind\./);
  });

  it('writes the results of calls a stopped session waited for into its transcript, and goes on', async () => {
    const { run, sdk } = setup([call('t1'), text('It shipped.')]);
    const first = await run([said('Where is order 7?')]);
    // The reasoning level changes while the call runs: the session is started again.
    const second = await run(
      [said('Where is order 7?'), first.message, result('t1', 'Order 7: shipped.')],
      { reasoning: 'low' },
    );
    expect(textOf(second)).toBe('It shipped.');
    const resumed = sdk.sessions[1];
    const written = resumed?.resumedWith?.at(-1);
    expect(written).toMatchObject({
      type: 'user',
      parentUuid: first.message.id,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [{ type: 'text', text: 'Order 7: shipped.' }],
          },
        ],
      },
    });
    expect(resumed?.heard.map((one) => one.message.content)).toEqual([
      [{ type: 'text', text: 'The results of your tool calls are above: go on.' }],
    ]);
  });

  it('starts afresh for a conversation that has no answer yet, and forgets the session before', async () => {
    const { run, sdk, logs } = setup([text('One.'), text('Two.')]);
    await run([said('Hi')]);
    const before = sdk.sessions[0]?.options['sessionId'];
    await run([said('Hello')], { instructions: 'Other.' });
    const after = sdk.sessions[1]?.options['sessionId'];
    expect(after).not.toBe(before);
    expect(sdk.sessions[1]?.options['resume']).toBeUndefined();
    expect([...(logs.kept.get('act_1')?.keys() ?? [])].toSorted()).toEqual([
      'session',
      `transcript/${String(after)}/`,
    ]);
  });

  it('refuses to go on with a conversation that was not had on Claude', async () => {
    const { run } = setup([]);
    const elsewhere: Message = {
      role: 'assistant',
      provider: 'claude',
      api: 'anthropic-messages',
      model: 'x',
      id: 'a0',
      content: [],
    };
    await expect(run([said('Hi'), elsewhere, said('Again')])).rejects.toMatchObject({
      kind: 'invalid_request',
    });
  });

  it('stops a session that has nothing to do for a while, and resumes it at the next call', async () => {
    const { run, sdk } = setup([text('One.'), text('Two.')], { idleMs: 20 });
    const first = await run([said('Hi')]);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(sdk.sessions[0]?.stopped).toBe(true);
    const second = await run([said('Hi'), first.message, said('Again')]);
    expect(textOf(second)).toBe('Two.');
    expect(sdk.sessions[1]?.options['resume']).toBe(sdk.sessions[0]?.options['sessionId']);
  });

  it('keeps only so many sessions, stopping the one that waited longest to make room', async () => {
    const { runner, sdk, step, signal } = setup([text('A.'), text('B.')], { maxSessions: 1 });
    await runner.run(step([said('Hi')], { session: 'act_1' }), signal);
    await runner.run(step([said('Hi')], { session: 'act_2' }), signal);
    expect(sdk.sessions[0]?.stopped).toBe(true);
    expect(sdk.sessions[1]?.stopped).toBe(false);
  });

  it("takes a search of Claude Code's own as the server's, and goes on without the engine", async () => {
    const { run } = setup([
      {
        content: [{ type: 'tool_use', id: 's1', name: 'WebSearch', input: { query: 'node' } }],
        stop: 'tool_use',
      },
      text('Node 26.'),
    ]);
    const first = await run([said('Search')], { options: { webSearch: true } });
    expect(first.stopReason).toBe('pause_turn');
    expect(first.toolCalls).toEqual([]);
    expect(first.message.content[0]).toEqual({
      type: 'server_tool_use',
      id: 's1',
      name: 'web_search',
      input: { query: 'node' },
    });
    const second = await run([said('Search'), first.message], { options: { webSearch: true } });
    expect(textOf(second)).toBe('Node 26.');
  });

  it("gives an agent that searches Claude Code's search, and no list of sites", () => {
    const { provider } = setup([]);
    expect(provider.parseOptions({ webSearch: true })).toEqual({ webSearch: true });
    expect(provider.parseOptions(undefined)).toEqual({});
    expect(() => provider.parseOptions({ webSearch: { allowedDomains: ['example.com'] } })).toThrow(
      /no list of sites/,
    );
    expect(() => provider.parseOptions({ temperature: 1 })).toThrow(/temperature/);
  });
});

describe('a failed call of the Claude provider', () => {
  const signIn = (dir: string): void => {
    mkdirSync(join(dir, 'accounts', 'acct-1'), { recursive: true });
    writeFileSync(join(dir, 'accounts', 'acct-1', 'signed-in'), '');
  };

  it('reads as signed out when Claude Code says it is not signed in', async () => {
    const { run } = setup([{ fail: 'Not logged in · Please run /login' }]);
    await expect(run([said('Hi')])).rejects.toMatchObject({ kind: 'auth', provider: 'claude' });
  });

  it('reads as a failure to try again when Claude Code was refused, though it is signed in', async () => {
    const { run, dir } = setup([{ fail: 'OAuth token has expired' }, text('Hello.')]);
    signIn(dir);
    await expect(run([said('Hi')])).rejects.toMatchObject({
      kind: 'provider_error',
      retryable: true,
    });
    // The session that failed is not gone on with: the call made again starts another.
    const answer = await run([said('Hi')]);
    expect(textOf(answer)).toBe('Hello.');
  });

  it("reads as rate limited, until the plan's limit lifts, once the SDK says it was reached", async () => {
    const { run, dir } = setup([{ fail: 'Claude usage limit reached', limited: true }]);
    signIn(dir);
    const failure = (await run([said('Hi')]).catch((error: unknown) => error)) as ModelFailure;
    expect(failure.kind).toBe('rate_limited');
    expect(failure.retryAfterMs).toBeGreaterThan(3_500_000);
  });

  it('reads as too long for the model when Claude Code says the prompt is', async () => {
    const { run, dir } = setup([{ fail: 'Prompt is too long' }]);
    signIn(dir);
    await expect(run([said('Hi')])).rejects.toMatchObject({ kind: 'context_overflow' });
  });

  it('is cancelled as soon as its signal is', async () => {
    const { runner, step } = setup([call('t1')]);
    const controller = new AbortController();
    const first = await runner.run(step([said('Hi')]), controller.signal);
    // Nothing new to send, and nothing coming: the call waits until it is cancelled.
    const waiting = runner.run(step([said('Hi'), first.message, said('Go on')]), controller.signal);
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(ModelFailure);
  });
});
