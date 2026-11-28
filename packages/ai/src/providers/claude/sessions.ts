// The Claude Agent SDK's sessions, one for each conversation, on which a conversation's model
// calls are made while the engine runs it as it runs every other.
//
// The SDK is a loop: it calls the model, runs the tools, and calls the model again until the
// model stops. The engine is a loop too, of steps it stores one by one. The two are put one on
// the other: each call of the engine's is one answer of the conversation's session.
//
//   - The session's tools are the engine's, and their handlers run nothing: a call waits there
//     until the engine has run it its own way, and its result reaches the SDK with the next
//     step, at the end of its conversation.
//   - What else is new at the end of the conversation (a person's message, a notice) is sent
//     into the session as a message of the user's. Sent while tool calls wait, the SDK puts it
//     after their results.
//   - Claude Code's own tools are all off, and so are the settings, memory and files it would
//     read from the host: the model sees the engine's tools and instructions only, and Claude
//     Code's own web search for an agent that asks for one.
//   - Claude Code compacts the conversation it sends the model, at the step's `compactAt`. The
//     engine never compacts this provider's conversations itself.
//
// The session keeps its own copy of the conversation, which the model is sent; the engine's is
// what a person is shown, and what a session is put back to. What the SDK writes of a session
// is kept in the conversation's log as well as in Claude Code's own file, so that a session
// that was stopped (by a restart, a failure, a change of what it was started with, or for
// having nothing to do) is resumed: cut back to the last answer the engine stored, with the
// results the engine got for its calls written in after it.
//
// Each session is a process of Claude Code's, which holds some hundreds of megabytes. One that
// has nothing to do for a while is stopped, and only so many are kept at once.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  AssistantMessage,
  FunctionTool,
  JsonObject,
  Message,
  StopReason,
  ToolResultMessage,
  Usage,
} from '@acentric/protocol';

import { parts } from '../../anthropic/request.ts';
import { toolCalls } from '../../anthropic/read.ts';
import { ModelFailure } from '../../failure.ts';
import type { FailureKind } from '../../failure.ts';
import type { SessionLog } from '../../provider.ts';
import type { ModelAnswer, ModelStep } from '../../runner.ts';
import { envOf, folderOf, status } from './program.ts';
import type { Program } from './program.ts';
import type {
  ClaudeSdk,
  SdkMessage,
  SdkQuery,
  SdkSessionStore,
  SdkUserMessage,
  SessionKey,
  ToolResult,
  TranscriptEntry,
} from './sdk.ts';
import { ToolServer } from './tools.ts';

export const PROVIDER = 'claude';
export const LABEL = 'Claude';
/** The wire format of the answers: Claude Code's are Anthropic's messages. */
export const MESSAGES_API = 'anthropic-messages';

/** The name of the server that has the engine's tools. Its tools keep their own names. */
const SERVER = 'engine';
/** Claude Code's own web search, which it runs itself. */
const SDK_SEARCH = 'WebSearch';
/** The log's stream that names the conversation's session. */
const SESSION_STREAM = 'session';

/** Set in Claude Code: off, what it would read of the host or do besides the calls. */
const SET: { readonly [name: string]: string } = {
  // The engine's tools keep their names: `bash`, not `mcp__engine__bash`.
  CLAUDE_AGENT_SDK_MCP_NO_PREFIX: '1',
  CLAUDE_AGENT_SDK_CLIENT_APP: 'acentric',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  DISABLE_AUTOUPDATER: '1',
  // What the engine's tools return is sized by the engine; Claude Code would put a long result
  // in a file the model has no tool to read.
  MAX_MCP_OUTPUT_TOKENS: '500000',
  // Claude Code's own nudge, in the middle of a long turn, to tell the user how it goes: the
  // engine's actors are not in a chat.
  CLAUDE_CODE_SILENT_TURN_REMINDER: '0',
};

/**
 * What the model is told after its instructions, of what Claude Code puts in the conversation
 * itself, which the engine cannot leave out: a section on the server it runs on, and who the
 * Claude account is.
 */
const NOTE = `# What Claude Code adds

Your calls are made through Claude Code. It puts a section headed "# Environment" in this conversation, and context on the Claude account the calls are made on, such as its email address. Both are about the server the harness runs on and that account, not about your work or the people you work with: the working directory, platform, shell and OS it names are not yours. Do not act on them, and never repeat the account's email address.`;

/**
 * How far below the window Claude Code is given it compacts: it keeps 20,000 tokens for the
 * answer, and compacts a little before what is left fills. Seen at 2.1.329: given 100,000, it
 * compacted at 70,910.
 */
const COMPACTION_MARGIN = 30_000;
/** The smallest window Claude Code takes. A smaller one is taken as this. */
const SMALLEST_WINDOW = 100_000;

/** Anthropic's stop reasons, as every provider's are said. */
const STOP_REASONS: { readonly [reason: string]: StopReason } = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  model_context_window_exceeded: 'length',
  tool_use: 'tool_use',
  pause_turn: 'pause_turn',
  refusal: 'refusal',
};

/** One of the model's answers, as the session's events told it. */
type Answer = {
  /** The SDK's ID of the last entry of the answer: where the session is put back to. */
  readonly uuid: string;
  readonly content: readonly JsonObject[];
  readonly stopReason: string | undefined;
  readonly usage: Usage | undefined;
};

/** The answer being put together from a response's stream. */
type Building = {
  responseId: string;
  content: JsonObject[];
  uuid: string | undefined;
  stopReason: string | undefined;
  startUsage: JsonObject | undefined;
  endUsage: JsonObject | undefined;
};

/** A queue the SDK reads its input from, for as long as the session is open. */
class Inbox implements AsyncIterable<SdkUserMessage> {
  #items: SdkUserMessage[] = [];
  #wake: (() => void) | undefined;
  #ended = false;

  push(message: SdkUserMessage): void {
    this.#items.push(message);
    this.#wake?.();
  }

  end(): void {
    this.#ended = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SdkUserMessage> {
    while (true) {
      const next = this.#items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#ended) return;
      await new Promise<void>((resolve) => (this.#wake = resolve));
      this.#wake = undefined;
    }
  }
}

function failure(message: string, kind: FailureKind, retryAfterMs?: number): ModelFailure {
  return new ModelFailure(message, kind, {
    provider: PROVIDER,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

/** A conversation's open session: its Claude Code process, and where it is in the conversation. */
class Session {
  readonly key: string;
  readonly sessionId: string;
  readonly home: string;
  readonly input = new Inbox();
  readonly abort = new AbortController();
  /** How many of the engine's messages the session has, its last answer included. */
  known = 0;
  /** The ID the engine stored the last answer under. */
  lastAnswer: string | undefined;
  /** The tool calls whose handlers wait for the engine's result, by the call's ID. */
  readonly waiting = new Map<string, (result: ToolResult) => void>();
  /** Why the session cannot go on. It is closed, and the next call resumes it. */
  failure: ModelFailure | undefined;
  idle: ReturnType<typeof setTimeout> | undefined;
  query: SdkQuery | undefined;
  /** When it last gave an answer or was sent something: the one that waited longest goes first. */
  usedAt = Date.now();
  /** Whether a call waits for its answer: a session in a call is not stopped to make room. */
  inCall = false;
  /**
   * Its last answer's only calls are searches Claude Code makes itself: the next answer comes
   * without the engine sending anything.
   */
  searching = false;
  #answers: Answer[] = [];
  #taker: { resolve: (answer: Answer) => void; reject: (error: ModelFailure) => void } | undefined;
  #building: Building | undefined;
  /** The text of an answer the SDK made up itself, such as an API error it gave up on. */
  #said: string | undefined;
  /** When the plan's limit lifts, once the SDK said it was reached. */
  #limited: number | undefined;
  #stderr: string[] = [];

  constructor(key: string, sessionId: string, home: string) {
    this.key = key;
    this.sessionId = sessionId;
    this.home = home;
  }

  /** The last of what Claude Code wrote to its error output. */
  get said(): string {
    return this.#stderr.join('').trim();
  }

  stderr(text: string): void {
    this.#stderr.push(text);
    if (this.#stderr.length > 20) this.#stderr.shift();
  }

  /** The next answer, or the failure that stopped the session. */
  next(signal: AbortSignal): Promise<Answer> {
    const ready = this.#answers.shift();
    if (ready !== undefined) return Promise.resolve(ready);
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return new Promise<Answer>((resolve, reject) => {
      const stop = (): void => {
        this.#taker = undefined;
        reject(failure('The call was cancelled', 'other'));
      };
      if (signal.aborted) {
        stop();
        return;
      }
      signal.addEventListener('abort', stop, { once: true });
      this.#taker = {
        resolve: (answer) => {
          signal.removeEventListener('abort', stop);
          resolve(answer);
        },
        reject: (error) => {
          signal.removeEventListener('abort', stop);
          reject(error);
        },
      };
    });
  }

  #give(answer: Answer): void {
    const taker = this.#taker;
    this.#taker = undefined;
    if (taker === undefined) this.#answers.push(answer);
    else taker.resolve(answer);
  }

  fail(error: ModelFailure): void {
    this.failure ??= error;
    const taker = this.#taker;
    this.#taker = undefined;
    taker?.reject(this.failure);
  }

  /** Reads the session's events until its process ends. */
  async pump(events: AsyncIterable<SdkMessage>): Promise<void> {
    try {
      for await (const event of events) this.#read(event);
      this.fail(failure('Claude Code stopped', 'provider_error'));
    } catch (error) {
      this.fail(this.failureOf(error instanceof Error ? error.message : String(error)));
    }
  }

  #read(event: SdkMessage): void {
    switch (event.type) {
      case 'stream_event': {
        // A subagent's stream is not the conversation's: Claude Code's own are off anyway.
        if (event['parent_tool_use_id'] !== null) return;
        const raw = event['event'] as { readonly type: string; readonly [key: string]: unknown };
        if (raw.type === 'message_start') {
          const message = raw['message'] as { readonly id: string; readonly usage?: JsonObject };
          this.#building = {
            responseId: message.id,
            content: [],
            uuid: undefined,
            stopReason: undefined,
            startUsage: message.usage,
            endUsage: undefined,
          };
        } else if (raw.type === 'message_delta' && this.#building !== undefined) {
          const delta = raw['delta'] as { readonly stop_reason?: string | null };
          this.#building.stopReason = delta.stop_reason ?? undefined;
          this.#building.endUsage = raw['usage'] as JsonObject | undefined;
        } else if (raw.type === 'message_stop' && this.#building !== undefined) {
          // Each block reached the session as a message of its own before the response stopped.
          const built = this.#building;
          this.#building = undefined;
          if (built.uuid === undefined) return;
          this.#give({
            uuid: built.uuid,
            content: built.content,
            stopReason: built.stopReason,
            usage: usageOf(built.startUsage, built.endUsage),
          });
        }
        return;
      }
      case 'assistant': {
        if (event['parent_tool_use_id'] !== null) return;
        const message = event['message'] as { readonly id?: string; readonly content: unknown[] };
        const building = this.#building;
        if (building !== undefined && message.id === building.responseId) {
          building.content.push(...(message.content as JsonObject[]));
          building.uuid = event['uuid'] as string;
          return;
        }
        // An answer that was never streamed is the SDK's own, such as an error it gave up on.
        this.#said = message.content
          .map((block) => {
            const text = (block as { readonly text?: unknown }).text;
            return typeof text === 'string' ? text : '';
          })
          .join('');
        return;
      }
      case 'rate_limit_event': {
        const info = event['rate_limit_info'] as
          { readonly status?: string; readonly resetsAt?: number } | undefined;
        if (info?.status === 'rejected') {
          this.#limited = (info.resetsAt ?? 0) * 1000 || Date.now() + 60_000;
        }
        return;
      }
      case 'result': {
        // A turn that ended with no answer for the engine: the SDK gave up on the call.
        if (this.#taker === undefined) return;
        const errors = event['errors'] as readonly string[] | undefined;
        const why =
          event['subtype'] === 'success'
            ? event['terminal_reason'] === 'completed'
              ? undefined
              : (this.#said ?? (event['result'] as string | undefined))
            : (errors?.join('; ') ?? this.#said ?? String(event['subtype']));
        this.fail(this.failureOf(why ?? 'Claude Code ended the turn without an answer'));
        return;
      }
      default:
        return;
    }
  }

  /** A failure of what Claude Code said, of the kind it reads as. */
  failureOf(text: string): ModelFailure {
    const said =
      text.trim() === '' ? (this.#stderr.at(-1)?.trim() ?? 'Claude Code failed') : text.trim();
    if (/not logged in|\/login|invalid api key|oauth|authenticat/i.test(said)) {
      return failure(`Claude Code is not signed in: ${said}`, 'auth');
    }
    if (this.#limited !== undefined) {
      return failure(
        `The Claude plan's usage limit was reached: ${said}`,
        'rate_limited',
        Math.max(0, this.#limited - Date.now()),
      );
    }
    if (/prompt is too long|context window/i.test(said)) {
      return failure(`Claude Code: ${said}`, 'context_overflow');
    }
    return failure(`Claude Code: ${said}`, 'provider_error');
  }
}

/** Anthropic's usage, as the start of a response and its end reported it. */
function usageOf(start: JsonObject | undefined, end: JsonObject | undefined): Usage | undefined {
  if (start === undefined && end === undefined) return undefined;
  const count = (key: string): number => {
    const value = end?.[key] ?? start?.[key];
    return typeof value === 'number' ? value : 0;
  };
  const input = count('input_tokens');
  const cacheRead = count('cache_read_input_tokens');
  const cacheWrite = count('cache_creation_input_tokens');
  return {
    totalInput: input + cacheRead + cacheWrite,
    input,
    output: count('output_tokens'),
    cacheRead,
    cacheWrite,
  };
}

/** A tool's result as MCP's: text and images. Anything else is said in text. */
function resultOf(message: ToolResultMessage): ToolResult {
  const content = message.content.map((part) => {
    if (part.type === 'text') return { type: 'text' as const, text: part.text };
    if (part.type === 'image' && part.source.type === 'base64') {
      return { type: 'image' as const, data: part.source.data, mimeType: part.source.mediaType };
    }
    return { type: 'text' as const, text: `[a ${part.type} that cannot be shown here]` };
  });
  return {
    content: content.length === 0 ? [{ type: 'text', text: '' }] : content,
    ...(message.isError === true ? { isError: true as const } : {}),
  };
}

/** A tool's result as an Anthropic block of a message of the user's. */
function resultBlockOf(message: ToolResultMessage): JsonObject {
  const { content, isError } = resultOf(message);
  return {
    type: 'tool_result',
    tool_use_id: message.toolCallId,
    content: content.map((part) =>
      part.type === 'text'
        ? { type: 'text', text: part.text }
        : { type: 'image', source: { type: 'base64', media_type: part.mimeType, data: part.data } },
    ),
    ...(isError === true ? { is_error: true } : {}),
  };
}

/** Whether the agent asked for a web search, which a session has as Claude Code's own. */
function searches(step: ModelStep): boolean {
  return step.options?.['webSearch'] === true;
}

/** What a session is started with: when any of it changes, it is started again, and resumed. */
function keyOf(step: ModelStep, home: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        home,
        model: step.model,
        reasoning: step.reasoning,
        instructions: step.instructions,
        tools: step.tools,
        search: searches(step),
        compactAt: step.compactAt ?? null,
      }),
    )
    .digest('hex');
}

/** The IDs of the tool calls in an answer the engine stored. */
function callIdsOf(message: Message): Set<string> {
  if (message.role !== 'assistant') return new Set();
  return new Set(
    message.content.flatMap((block) =>
      block['type'] === 'tool_use' && typeof block['id'] === 'string' ? [block['id']] : [],
    ),
  );
}

/** The IDs of the searches of Claude Code's own in an answer the engine stored. */
function searchIdsOf(message: Message): string[] {
  if (message.role !== 'assistant') return [];
  return message.content.flatMap((block) =>
    block['type'] === 'server_tool_use' &&
    block['name'] === 'web_search' &&
    typeof block['id'] === 'string'
      ? [block['id']]
      : [],
  );
}

/**
 * A block of an answer as the engine keeps it. A call of Claude Code's own search is the
 * server's, as Anthropic's search is, so that the engine does not take it as one to run. A call
 * of the engine's tools keeps the tool's own name.
 */
function asKept(block: JsonObject): JsonObject {
  if (block['type'] !== 'tool_use') return block;
  if (block['name'] === SDK_SEARCH) {
    return {
      type: 'server_tool_use',
      id: block['id'] ?? '',
      name: 'web_search',
      input: block['input'] ?? {},
    };
  }
  const name = block['name'];
  const prefix = `mcp__${SERVER}__`;
  return typeof name === 'string' && name.startsWith(prefix)
    ? { ...block, name: name.slice(prefix.length) }
    : block;
}

/** How a session is put back to the engine's conversation when it is resumed. */
type Rewind = {
  /** The entry of the last answer the engine stored. What the session has after it is dropped. */
  readonly at: string;
  /** The results the engine got for that answer's calls, written in after it. */
  readonly results: readonly ToolResultMessage[];
};

/**
 * A transcript entry with the results of an answer's tool calls, written after the entry
 * `after` as Claude Code writes the results it got itself. It is Claude Code's own format,
 * which its SDK does not document: it may change with Claude Code. (Sent in a message of the
 * user's in place of this, results are not taken: Claude Code resumes a session whose last
 * answer's calls have no results by saying each was cut off.)
 */
function resultsEntry(
  after: TranscriptEntry,
  results: readonly ToolResultMessage[],
): TranscriptEntry {
  const copied = (name: string): { readonly [key: string]: unknown } =>
    after[name] === undefined ? {} : { [name]: after[name] };
  return {
    parentUuid: after['uuid'],
    isSidechain: false,
    type: 'user',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: results.map(resultBlockOf) },
    sourceToolAssistantUUID: after['uuid'],
    ...copied('userType'),
    ...copied('entrypoint'),
    ...copied('cwd'),
    ...copied('sessionId'),
    ...copied('version'),
    ...copied('gitBranch'),
  };
}

/** The stream of the log that keeps one of a session's transcripts. */
function streamOf(key: { readonly sessionId: string; readonly subpath?: string }): string {
  return `transcript/${key.sessionId}/${key.subpath ?? ''}`;
}

export type SessionsOptions = {
  readonly sdk: ClaudeSdk;
  readonly program: Program;
  /** The folder the sessions run in: the working directory Claude Code names. */
  readonly workDir: string;
  /** How long a session with nothing to do is kept before its process is stopped. */
  readonly idleMs: number;
  /** How many sessions' processes are kept at once. */
  readonly maxSessions: number;
  /** Where what Claude Code said of a session that failed is written. */
  readonly report: (line: string) => void;
};

/** The sessions of the conversations on Claude, by the session their steps name. */
export class ClaudeSessions {
  readonly #options: SessionsOptions;
  readonly #live = new Map<string, Session>();
  #closed = false;

  constructor(options: SessionsOptions) {
    this.#options = options;
  }

  /** How many sessions' processes run. */
  get live(): number {
    return this.#live.size;
  }

  /** Stops every session's process. Each is resumed when it is called again. */
  close(): void {
    this.#closed = true;
    for (const id of this.#live.keys()) this.#close(id);
  }

  /** One call of the model, on the conversation's session. */
  async run(
    step: ModelStep,
    home: string,
    log: SessionLog,
    signal: AbortSignal,
  ): Promise<ModelAnswer> {
    const conversation = step.session;
    if (conversation === undefined) {
      throw failure(
        'A call of Claude names no conversation to keep a session of',
        'invalid_request',
      );
    }
    const { messages } = step;
    const key = keyOf(step, home);
    let session = this.#live.get(conversation);
    if (
      session !== undefined &&
      (session.key !== key || session.failure !== undefined || !holds(session, messages))
    ) {
      this.#close(conversation);
      session = undefined;
    }
    let tail: readonly Message[];
    if (session === undefined) {
      ({ session, tail } = await this.#start(conversation, step, key, home, log));
    } else {
      tail = messages.slice(session.known);
    }
    if (session.idle !== undefined) clearTimeout(session.idle);
    session.inCall = true;
    session.usedAt = Date.now();

    let answer: Answer;
    try {
      this.#send(session, tail);
      session.known = messages.length;
      answer = await session.next(signal);
    } catch (error) {
      session.inCall = false;
      // What Claude Code said of it is kept where an operator reads the server's log.
      if (!signal.aborted && session.said !== '') {
        this.#options.report(
          `The Claude session of ${conversation} failed: ${error instanceof Error ? error.message : String(error)}\nClaude Code said:\n${session.said}`,
        );
      }
      // A session stopped halfway is not gone on with: the next call resumes it, put back.
      this.#close(conversation);
      if (error instanceof ModelFailure && error.kind === 'auth')
        throw await this.#signedOut(error, home);
      throw error;
    }
    session.inCall = false;
    session.known += 1;
    session.lastAnswer = answer.uuid;
    session.usedAt = Date.now();
    const content = answer.content.map(asKept);
    const mapped =
      (answer.stopReason === undefined ? undefined : STOP_REASONS[answer.stopReason]) ?? 'stop';
    // An answer whose only calls are Claude Code's own searches goes on by itself, as one paused does.
    const stopReason =
      mapped === 'tool_use' && !content.some((block) => block['type'] === 'tool_use')
        ? 'pause_turn'
        : mapped;
    session.searching =
      stopReason === 'pause_turn' && content.some((block) => block['type'] === 'server_tool_use');
    // Stopped when nothing comes for a while: between turns, or while the engine runs tools.
    if (!session.searching) {
      const id = conversation;
      session.idle = setTimeout(() => this.#close(id), this.#options.idleMs);
      session.idle.unref();
    }
    const message: AssistantMessage = {
      role: 'assistant',
      provider: PROVIDER,
      api: MESSAGES_API,
      model: step.model,
      // The SDK's ID of the answer's entry, which a session is put back to.
      id: answer.uuid,
      content,
    };
    return {
      message,
      stopReason,
      toolCalls: toolCalls(content),
      ...(answer.usage === undefined ? {} : { usage: answer.usage }),
    };
  }

  /**
   * A failure that reads as signed out, once Claude Code was asked whether it is: one that
   * is signed in was refused for another reason, and may be made again.
   */
  async #signedOut(error: ModelFailure, home: string): Promise<ModelFailure> {
    try {
      const said = await status(this.#options.program, home);
      if (said.loggedIn) {
        return failure(
          `Claude Code was refused, though it is signed in: ${error.message}`,
          'provider_error',
        );
      }
    } catch {
      // Not known: taken as signed out.
    }
    return error;
  }

  /**
   * Starts a conversation's session: a new one for a conversation with no answer yet, or the
   * one it was in, resumed and put back to the engine's last answer. Returns what is still to
   * be sent.
   */
  async #start(
    conversation: string,
    step: ModelStep,
    key: string,
    home: string,
    log: SessionLog,
  ): Promise<{ session: Session; tail: readonly Message[] }> {
    const { messages } = step;
    const last = messages.findLastIndex((message) => message.role === 'assistant');
    let sessionId: string;
    let tail: readonly Message[];
    let rewind: Rewind | undefined;
    if (last === -1) {
      sessionId = randomUUID();
      await log.clear();
      await log.replace(SESSION_STREAM, [{ sessionId }]);
      tail = messages;
    } else {
      const answer = messages[last];
      const [kept] = await log.read(SESSION_STREAM);
      const id = kept?.['sessionId'];
      if (typeof id !== 'string' || answer?.id === undefined) {
        throw failure(
          'This conversation was not had on Claude, so there is no session of the Claude Agent SDK to go on with',
          'invalid_request',
        );
      }
      sessionId = id;
      const calls = callIdsOf(answer);
      const after = messages.slice(last + 1);
      const results: ToolResultMessage[] = [
        ...after.filter(
          (message): message is ToolResultMessage =>
            message.role === 'tool_result' && calls.has(message.toolCallId),
        ),
        // Claude Code's result of a search of its own is after the answer, and so is dropped.
        ...searchIdsOf(answer).map((callId): ToolResultMessage => ({
          role: 'tool_result',
          toolCallId: callId,
          toolName: SDK_SEARCH,
          content: [{ type: 'text', text: 'The search was cut off. Search again if you need it.' }],
          isError: true,
        })),
      ];
      rewind = { at: answer.id, results };
      tail = after.filter(
        (message) => !(message.role === 'tool_result' && calls.has(message.toolCallId)),
      );
      if (results.length > 0 && !tail.some(toldToModel)) {
        // The results are in the transcript, and a turn needs something new to start on.
        tail = [
          ...tail,
          {
            role: 'user',
            content: [{ type: 'text', text: 'The results of your tool calls are above: go on.' }],
          },
        ];
      }
    }

    this.#makeRoom();
    const session = new Session(key, sessionId, home);
    session.lastAnswer = last === -1 ? undefined : messages[last]?.id;
    const tools = step.tools.filter((tool): tool is FunctionTool => tool.type === 'function');
    const server = new ToolServer(SERVER, tools, ({ toolUseId }) => {
      if (toolUseId === undefined) {
        return Promise.resolve({
          content: [{ type: 'text', text: 'The harness could not tell which call this was.' }],
          isError: true,
        });
      }
      return new Promise<ToolResult>((resolve) => session.waiting.set(toolUseId, resolve));
    });
    const { program, workDir, sdk } = this.#options;
    mkdirSync(workDir, { recursive: true });
    const env = { ...envOf(program, home), ...SET };
    const search = searches(step);
    const compactAt = step.compactAt;
    const query = sdk.query({
      prompt: session.input,
      options: {
        model: step.model,
        systemPrompt: {
          type: 'custom',
          prompt: `${step.instructions}\n\n${NOTE}`,
          snapshot: false,
        },
        // Of Claude Code's own tools, only its web search, for an agent that has one.
        tools: search ? [SDK_SEARCH] : [],
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: { [SERVER]: server.config() },
        mcpServersDelivery: 'initialize',
        allowedTools: [
          ...tools.flatMap((tool) => [tool.name, `mcp__${SERVER}__${tool.name}`]),
          ...(search ? [SDK_SEARCH] : []),
        ],
        permissionMode: 'dontAsk',
        permissionPrompts: 'none',
        settings: {
          autoCompactEnabled: true,
          ...(compactAt === undefined
            ? {}
            : {
                autoCompactWindow: Math.max(
                  SMALLEST_WINDOW,
                  Math.round(compactAt + COMPACTION_MARGIN),
                ),
              }),
        },
        includePartialMessages: true,
        verbatimPrompts: true,
        thinking: { type: 'adaptive', display: 'summarized' },
        effort: step.reasoning,
        sessionStore: this.#storeOf(log, home, rewind),
        sessionStoreFlush: 'eager',
        ...(rewind === undefined ? { sessionId } : { resume: sessionId }),
        title: conversation,
        cwd: workDir,
        env,
        pathToClaudeCodeExecutable: program.binary,
        abortController: session.abort,
        stderr: (text: string) => session.stderr(text),
      },
    });
    session.query = query;
    this.#live.set(conversation, session);
    void session.pump(query);
    return { session, tail };
  }

  /**
   * Sends what is new: a message of the user's for each person's message or notice, and each
   * tool result to the call that waits for it. The messages go first, so that the SDK puts them
   * after the results when it calls the model again.
   */
  #send(session: Session, tail: readonly Message[]): void {
    const results = tail.filter(
      (message): message is ToolResultMessage => message.role === 'tool_result',
    );
    const told = tail.filter(toldToModel);
    if (results.length === 0 && told.length === 0) {
      // Claude Code is searching, and calls the model again itself.
      if (session.searching) return;
      throw failure('There is nothing new to send the model', 'invalid_request');
    }
    // Sent while tools run, a message is heard after their results.
    const busy = session.waiting.size > 0 || session.searching;
    session.searching = false;
    for (const message of told) {
      if (message.role !== 'user' && message.role !== 'system') continue;
      const content = parts(message.content, 'message');
      if (content.length === 0) continue;
      session.input.push({
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
        ...(busy ? { priority: 'next' as const } : {}),
      });
    }
    for (const result of results) {
      const resolve = session.waiting.get(result.toolCallId);
      if (resolve === undefined) continue;
      session.waiting.delete(result.toolCallId);
      resolve(resultOf(result));
    }
  }

  /**
   * Stops the session that waited longest while there are as many as may be kept, so that one
   * more can start. One in a call is never stopped: with all in one, there are more for a while.
   */
  #makeRoom(): void {
    while (this.#live.size >= this.#options.maxSessions) {
      let oldest: [string, Session] | undefined;
      for (const entry of this.#live) {
        if (!entry[1].inCall && (oldest === undefined || entry[1].usedAt < oldest[1].usedAt)) {
          oldest = entry;
        }
      }
      if (oldest === undefined) return;
      this.#close(oldest[0]);
    }
  }

  /**
   * Stops a session's process. Its turn is interrupted first: stopped only, Claude Code would go
   * on for a moment, find its tools gone, and call the model again.
   */
  #close(conversation: string): void {
    const session = this.#live.get(conversation);
    if (session === undefined) return;
    this.#live.delete(conversation);
    if (session.idle !== undefined) clearTimeout(session.idle);
    session.fail(failure('The session was closed', 'other'));
    const stop = (): void => {
      session.input.end();
      session.abort.abort();
    };
    const interrupted = session.query?.interrupt().catch(() => undefined) ?? Promise.resolve();
    const late = setTimeout(stop, 1_000);
    late.unref();
    void interrupted.then(() => {
      clearTimeout(late);
      stop();
    });
  }

  /** Where a session's transcripts are kept: the conversation's log, and Claude Code's own file. */
  #storeOf(log: SessionLog, home: string, rewind: Rewind | undefined): SdkSessionStore {
    let putBack = rewind;
    const fileOf = (key: SessionKey): string => {
      const name =
        key.subpath === undefined
          ? `${key.sessionId}.jsonl`
          : join(key.sessionId, `${key.subpath}.jsonl`);
      return join(folderOf(this.#options.program, home), 'projects', key.projectKey, name);
    };
    return {
      append: async (key, entries) => {
        // Told after the server closed: Claude Code's own file has them.
        if (this.#closed) return;
        await log.append(streamOf(key), entries as JsonObject[]);
      },
      listSubkeys: async (key) => {
        const prefix = `transcript/${key.sessionId}/`;
        return (await log.streams())
          .filter((stream) => stream.startsWith(prefix) && stream.length > prefix.length)
          .map((stream) => stream.slice(prefix.length));
      },
      load: async (key) => {
        const stream = streamOf(key);
        let entries: TranscriptEntry[] = await log.read(stream);
        const rewound = key.subpath === undefined ? putBack : undefined;
        // Claude Code writes its own file before it tells the log: after a sudden stop, the file
        // may have the answer the log was not told of.
        const lacks =
          rewound !== undefined && !entries.some((entry) => entry['uuid'] === rewound.at);
        if (entries.length === 0 || lacks) {
          const file = fileOf(key);
          const fromFile = existsSync(file)
            ? readFileSync(file, 'utf8')
                .split('\n')
                .filter((line) => line.trim() !== '')
                .map((line) => JSON.parse(line) as TranscriptEntry)
            : [];
          if (fromFile.length > 0) entries = fromFile;
        }
        if (entries.length === 0) return null;
        if (rewound === undefined) return entries;
        putBack = undefined;
        const at = entries.findLastIndex((entry) => entry['uuid'] === rewound.at);
        if (at === -1) {
          throw new Error(`The session ${key.sessionId} has no answer ${rewound.at} to go on from`);
        }
        const kept = entries.slice(0, at + 1);
        const answered = entries[at];
        if (rewound.results.length > 0 && answered !== undefined) {
          kept.push(resultsEntry(answered, rewound.results));
        }
        await log.replace(stream, kept as JsonObject[]);
        return kept;
      },
    };
  }
}

/** Whether a message is one that is said to the model: a person's, or a notice. */
function toldToModel(message: Message): boolean {
  return message.role === 'user' || message.role === 'system';
}

/** Whether a session has the engine's conversation as it is: its last answer where it put it. */
function holds(session: Session, messages: readonly Message[]): boolean {
  if (messages.length < session.known) return false;
  if (session.lastAnswer === undefined) return true;
  const answer = messages[session.known - 1];
  return answer?.role === 'assistant' && answer.id === session.lastAnswer;
}
