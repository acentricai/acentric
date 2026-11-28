// A stand-in for the Claude Agent SDK and its Claude Code, for the tests of the Claude
// provider: a session that answers from a script, calls the tools of the server it is given
// over MCP as Claude Code does, and keeps its transcript in the session store it is given.
// And a stand-in `claude` program, for signing in and asking whether it is signed in.

import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JsonObject } from '@acentric/protocol';

import type { SessionLog, SessionLogs } from '../src/provider.ts';
import type {
  ClaudeSdk,
  SdkMessage,
  SdkQuery,
  SdkSessionStore,
  SdkUserMessage,
  TranscriptEntry,
} from '../src/providers/claude/sdk.ts';

/** One answer of the scripted model: its blocks, and why it stopped. */
export type Scripted =
  | {
      readonly content: readonly JsonObject[];
      readonly stop?: string;
      readonly usage?: JsonObject;
    }
  /** The SDK gives up on the call, saying this; after its plan's limit, when `limited`. */
  | { readonly fail: string; readonly limited?: true };

/** What a session was started with, and what it was told. */
export type Started = {
  readonly options: { readonly [option: string]: unknown };
  /** The messages of the user's it read, in order. */
  readonly heard: SdkUserMessage[];
  /** What the transcript held when it was resumed. */
  resumedWith: TranscriptEntry[] | null;
  /** The results its tool calls got, in order. */
  readonly results: { readonly id: string; readonly result: JsonObject }[];
  stopped: boolean;
};

type RpcReply = { readonly id: number; readonly result?: JsonObject; readonly error?: JsonObject };

/** The scripted SDK: each answer is taken from `script`, in order, whichever session asks. */
export function fakeSdk(script: Scripted[]): ClaudeSdk & { readonly sessions: Started[] } {
  const sessions: Started[] = [];
  let made = 0;
  const query = (params: {
    readonly prompt: AsyncIterable<SdkUserMessage>;
    readonly options: { readonly [option: string]: unknown };
  }): SdkQuery => {
    const { options } = params;
    const store = options['sessionStore'] as SdkSessionStore;
    const resume = options['resume'] as string | undefined;
    const sessionId = (resume ?? options['sessionId']) as string;
    const key = { projectKey: 'project', sessionId };
    const abort = (options['abortController'] as AbortController).signal;
    const started: Started = { options, heard: [], resumedWith: null, results: [], stopped: false };
    sessions.push(started);
    const server = (
      options['mcpServers'] as {
        readonly [name: string]: { readonly instance: { connect(t: unknown): Promise<void> } };
      }
    )['engine'];
    let next = 0;
    const waiting = new Map<number, (reply: RpcReply) => void>();
    let onmessage: ((message: unknown) => void) | undefined;
    const transport = {
      set onmessage(handler: (message: unknown) => void) {
        onmessage = handler;
      },
      get onmessage() {
        return onmessage as never;
      },
      async start() {},
      async send(message: RpcReply) {
        waiting.get(message.id)?.(message);
        waiting.delete(message.id);
      },
      async close() {},
    };
    const ask = (method: string, rpcParams: JsonObject): Promise<RpcReply> =>
      new Promise((resolve) => {
        next += 1;
        waiting.set(next, resolve);
        onmessage?.({ jsonrpc: '2.0', id: next, method, params: rpcParams });
      });
    let last: string | null = null;
    let lastFailed = false;
    const failed = (): boolean => {
      const was = lastFailed;
      lastFailed = false;
      return was;
    };
    const write = async (entry: TranscriptEntry): Promise<void> => {
      await store.append(key, [entry]);
      last = String(entry['uuid']);
    };

    async function* events(): AsyncGenerator<SdkMessage> {
      await server?.instance.connect(transport);
      await ask('initialize', { protocolVersion: '2025-06-18' });
      if (resume !== undefined) {
        started.resumedWith = await store.load(key);
        const end = started.resumedWith?.at(-1);
        last = end === undefined ? null : String(end['uuid']);
      }
      const input = params.prompt[Symbol.asyncIterator]();
      for (;;) {
        if (abort.aborted) return;
        const told = await Promise.race([
          input.next(),
          new Promise<{ done: true; value: undefined }>((resolve) =>
            abort.addEventListener('abort', () => resolve({ done: true, value: undefined }), {
              once: true,
            }),
          ),
        ]);
        if (told.done === true) return;
        started.heard.push(told.value);
        made += 1;
        await write({
          type: 'user',
          uuid: `u${String(made)}`,
          parentUuid: last,
          message: told.value.message,
        });
        // The model answers until it stops calling tools.
        for (;;) {
          const answer = script.shift();
          if (answer === undefined) throw new Error('The script has no answer left');
          if ('fail' in answer) {
            if (answer.limited === true) {
              yield {
                type: 'rate_limit_event',
                rate_limit_info: {
                  status: 'rejected',
                  resetsAt: Math.floor(Date.now() / 1000) + 3600,
                },
              };
            }
            yield {
              type: 'assistant',
              parent_tool_use_id: null,
              uuid: 'x',
              message: { content: [{ type: 'text', text: answer.fail }] },
            };
            yield {
              type: 'result',
              subtype: 'success',
              terminal_reason: 'api_error',
              result: answer.fail,
            };
            lastFailed = true;
            break;
          }
          made += 1;
          const id = `msg_${String(made)}`;
          yield {
            type: 'stream_event',
            parent_tool_use_id: null,
            event: {
              type: 'message_start',
              message: {
                id,
                usage: answer.usage ?? {
                  input_tokens: 10,
                  cache_read_input_tokens: 90,
                  cache_creation_input_tokens: 5,
                },
              },
            },
          };
          for (const [index, block] of answer.content.entries()) {
            const uuid = `a${String(made)}-${String(index)}`;
            await write({
              type: 'assistant',
              uuid,
              parentUuid: last,
              message: { id, content: [block] },
            });
            yield {
              type: 'assistant',
              parent_tool_use_id: null,
              uuid,
              message: { id, content: [block] },
            };
          }
          yield {
            type: 'stream_event',
            parent_tool_use_id: null,
            event: {
              type: 'message_delta',
              delta: { stop_reason: answer.stop ?? 'end_turn' },
              usage: { output_tokens: 7 },
            },
          };
          yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } };
          const calls = answer.content.filter(
            (block) => block['type'] === 'tool_use' && block['name'] !== 'WebSearch',
          );
          const searched = answer.content.some((block) => block['name'] === 'WebSearch');
          if (calls.length === 0 && !searched) break;
          const results: JsonObject[] = [];
          for (const call of calls) {
            const reply = await Promise.race([
              ask('tools/call', {
                name: String(call['name']),
                arguments: (call['input'] ?? {}) as JsonObject,
                _meta: { 'claudecode/toolUseId': String(call['id']) },
              }),
              new Promise<undefined>((resolve) =>
                abort.addEventListener('abort', () => resolve(undefined), { once: true }),
              ),
            ]);
            if (reply === undefined) return;
            started.results.push({ id: String(call['id']), result: reply.result ?? {} });
            results.push({ type: 'tool_result', tool_use_id: call['id'] ?? '', ...reply.result });
          }
          made += 1;
          await write({
            type: 'user',
            uuid: `r${String(made)}`,
            parentUuid: last,
            message: { role: 'user', content: results },
          });
        }
        if (started.results.length >= 0 && !failed()) {
          yield { type: 'result', subtype: 'success', terminal_reason: 'completed' };
        }
      }
    }
    const iterator = events();
    return {
      [Symbol.asyncIterator]: () => iterator,
      async interrupt() {
        started.stopped = true;
      },
    };
  };
  return { query, sessions };
}

/** Session logs kept in memory, by session. */
export function memoryLogs(): SessionLogs & {
  readonly kept: Map<string, Map<string, JsonObject[]>>;
} {
  const kept = new Map<string, Map<string, JsonObject[]>>();
  const logs = (session: string): SessionLog => {
    const streams = (): Map<string, JsonObject[]> => {
      let found = kept.get(session);
      if (found === undefined) {
        found = new Map();
        kept.set(session, found);
      }
      return found;
    };
    return {
      read: async (stream) => structuredClone(streams().get(stream) ?? []),
      append: async (stream, entries) => {
        streams().set(stream, [...(streams().get(stream) ?? []), ...structuredClone(entries)]);
      },
      replace: async (stream, entries) => {
        streams().set(stream, structuredClone([...entries]));
      },
      streams: async () => [...streams().keys()],
      clear: async () => {
        kept.delete(session);
      },
    };
  };
  return Object.assign(logs, { kept });
}

/**
 * A stand-in `claude` program, in a folder of its own, and that folder. It is signed in once a
 * `signed-in` file is in its home: `auth login` takes the code `good-code`, and asks again for
 * any other.
 */
export function fakeProgram(): { readonly binary: string; readonly dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
  const binary = join(dir, 'claude');
  writeFileSync(
    binary,
    `#!/bin/sh
case "$1 $2" in
  "auth status")
    if [ -f "$CLAUDE_CONFIG_DIR/signed-in" ]; then
      echo '{"loggedIn": true, "email": "ada@example.test", "subscriptionType": "max"}'
    else
      echo '{"loggedIn": false}'
    fi ;;
  "auth logout") rm -f "$CLAUDE_CONFIG_DIR/signed-in"; echo "Signed out" ;;
  "auth login")
    echo "Opening browser to sign in..."
    echo "If the browser didn't open, visit:"
    echo "https://claude.ai/oauth/authorize?z-$$"
    while true; do
      printf "Paste code here if prompted > "
      read code || exit 1
      if [ "$code" = "good-code" ]; then touch "$CLAUDE_CONFIG_DIR/signed-in"; echo "Signed in"; exit 0; fi
      echo "Invalid code"
    done ;;
esac
`,
  );
  chmodSync(binary, 0o755);
  return { binary, dir };
}
