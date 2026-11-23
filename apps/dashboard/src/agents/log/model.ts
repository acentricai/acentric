// An actor's conversation as the page draws it: each turn a band, its messages rows inside it,
// and each compaction a rule between them. Pure: given the messages read so far, the
// compactions and where the actor stands, it says what is on screen.
//
// The engine keeps no record of where a turn began. A turn ends when the model answers with no
// tool call, so a band runs from the first message after such an answer to the next one.

import type {
  Compaction,
  ConversationEntry,
  Json,
  JsonObject,
  TurnEnd,
  Usage,
} from '@acentric/protocol';

import { count, shortId, tokens } from '../../format.ts';
import { firstArgument, inputTokens, messageText, readResponse, readResult } from './read.ts';
import type { Standing } from './stream.ts';

/** A message of the conversation, with its place in it. */
export type Message = ConversationEntry;

export type Tone = 'plain' | 'muted' | 'waiting' | 'failed';

export type CallInfo = {
  readonly id: string;
  readonly name: string;
  readonly arguments: Json | string | undefined;
};

export type Row = {
  /** Unique within the log: `seq-4803`, or `call-<id>` for a call with no result. */
  readonly key: string;
  readonly seq: number | null;
  readonly at: number | null;
  readonly kind: string;
  readonly summary: string;
  /** Short words after the summary. */
  readonly tags: readonly string[];
  /** At the right: tokens, an input's ID, `awaiting result`. */
  readonly measure: string;
  readonly tone: Tone;
  /** Always 0: a script's own calls are not in the conversation. */
  readonly depth: 0 | 1;
  /** Drawn across, as a rule: a compaction. */
  readonly rule: boolean;
  /** The message the row is, or null for a call with no result and for a compaction. */
  readonly message: Message | null;
  /** For a tool result or a call with no result: the call. */
  readonly call: CallInfo | null;
  /** For a compaction's rule. */
  readonly compaction: Compaction | null;
};

export type BandStatus = 'running' | 'ended' | TurnEnd['end'];

export type Band = {
  readonly type: 'band';
  readonly key: string;
  /** Its turn, counted from 1 in the messages read. */
  readonly turn: number;
  readonly status: BandStatus;
  /** Why the last turn failed, or what interrupted it. */
  readonly reason: string | null;
  readonly rows: readonly Row[];
  readonly startedAt: number;
  readonly endedAt: number | null;
  /** Model answers in it. */
  readonly calls: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** The lowest `seq` it shows, which places it among the rules. */
  readonly first: number;
  readonly last: number;
};

export type Rule = { readonly type: 'rule'; readonly key: string; readonly row: Row };

export type LogItem = Band | Rule;

type Metadata = {
  readonly input?: { readonly type: string; readonly id: string };
  readonly stopReason?: string;
  readonly usage?: Usage;
  readonly compaction?: string;
  readonly agent?: { readonly name: string; readonly status: string };
  /** A task's ending: `problem` is what went wrong that the model was not told. */
  readonly notice?: { readonly problem?: string };
};

/** What the engine says of a message: what it kept beside it, and in the message's metadata. */
const metadataOf = (message: Message): Metadata => {
  const own = (message.message.metadata ?? {}) as unknown as Metadata;
  return {
    ...own,
    ...(message.input === undefined ? {} : { input: message.input }),
    ...(message.completion === undefined
      ? {}
      : {
          stopReason: message.completion.stopReason,
          ...(message.completion.usage === undefined ? {} : { usage: message.completion.usage }),
        }),
  };
};

/** The tokens and cost of a model's answer. */
export const usageOf = (message: Message): Usage | undefined => metadataOf(message).usage;

const base = (message: Message) => ({
  key: `seq-${message.seq}`,
  seq: message.seq,
  at: message.createdAt,
  tags: [] as string[],
  measure: '',
  tone: 'plain' as Tone,
  depth: 0 as const,
  rule: false,
  message,
  call: null,
  compaction: null,
});

/** The first line with something on it, cut at 200 characters. */
export function firstLineOf(text: string): string {
  for (const line of text.split(/\r\n|\r|\n/)) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed.length > 200 ? `${trimmed.slice(0, 199)}…` : trimmed;
  }
  return '';
}

/** What the harness's own lines are about, from the tag they start with. */
function noticeKind(text: string): string {
  const tag = /^<([a-z-]+)/.exec(text.trim())?.[1];
  if (tag === 'task') return 'task';
  if (tag === 'agent' || tag === 'message') return 'agent';
  if (tag === 'compacted') return 'context';
  return 'notice';
}

const isObject = (value: Json | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The effort a change of reasoning level, the engine's own item, changes it to. */
function reasoningChangeOf(items: readonly Json[]): string | undefined {
  const item = items.length === 1 ? items[0] : undefined;
  if (!isObject(item) || item['type'] !== 'configuration_update') return undefined;
  const reasoning = item['reasoning'];
  return isObject(reasoning) && typeof reasoning['effort'] === 'string'
    ? reasoning['effort']
    : undefined;
}

/** One line for each message, in the dashboard's words. */
export function describe(message: Message, calls: ReadonlyMap<string, CallInfo>): Row {
  const row = describeOne(message, calls);
  // What a refused turn was sent and did: still shown, and no longer sent to the model.
  return message.leftOut === true
    ? { ...row, tone: 'muted', tags: [...row.tags, 'left out'] }
    : row;
}

function describeOne(message: Message, calls: ReadonlyMap<string, CallInfo>): Row {
  const row = base(message);
  const meta = metadataOf(message);
  const m = message.message;
  switch (m.role) {
    case 'user': {
      if (meta.compaction === 'summary') {
        return {
          ...row,
          kind: 'context',
          summary: 'summary of the conversation before',
          tone: 'muted',
        };
      }
      const text = firstLineOf(messageText(m));
      const images = m.content.filter((part) => part.type === 'image').length;
      const summary = text || (images > 0 ? (images === 1 ? 'image' : `${images} images`) : '');
      if (meta.input === undefined) return { ...row, kind: 'user', summary };
      return { ...row, kind: `← ${meta.input.type}`, summary, measure: shortId(meta.input.id, 16) };
    }
    case 'system': {
      // A change of reasoning level, which Anthropic takes as a system message that says nothing.
      const config = m.providerOptions?.['output_config'];
      const effort =
        isObject(config) && typeof config['effort'] === 'string' ? config['effort'] : undefined;
      if (effort !== undefined)
        return { ...row, kind: 'reasoning', summary: `now ${effort}`, tone: 'muted' };
      const text = messageText(m);
      const described = {
        ...row,
        kind: noticeKind(text),
        summary: firstLineOf(text),
        tone: 'muted' as Tone,
      };
      // Such as a schedule handler that failed, for which the model was told the note alone.
      return meta.notice?.problem === undefined
        ? described
        : { ...described, tone: 'failed', tags: [firstLineOf(meta.notice.problem)] };
    }
    case 'assistant': {
      const view = readResponse(m);
      const text = firstLineOf(view.text) || firstLineOf(view.refusals[0] ?? '');
      const names = [
        ...view.searches.map(() => 'web search'),
        ...view.calls.map((call) => call.toolName),
      ];
      const arrow = names.length > 0 ? `→ ${names.join(', ')}` : '';
      const summary = [text, arrow].filter((part) => part !== '').join(' ');
      const thinking = summary === '' ? firstLineOf(view.thinking[0] ?? '') : '';
      return {
        ...row,
        kind: 'model',
        summary: summary || thinking || (meta.stopReason ?? ''),
        tone: summary === '' ? 'muted' : 'plain',
        measure: tokens(inputTokens(meta.usage), meta.usage?.output),
      };
    }
    case 'tool_result': {
      const result = readResult(m);
      const known = calls.get(m.toolCallId);
      const call: CallInfo = { id: m.toolCallId, name: result.name, arguments: known?.arguments };
      return {
        ...row,
        kind: `${result.isError ? '✕' : '✓'} ${result.name}`,
        summary: result.isError ? firstLineOf(result.text) : firstArgument(known?.arguments),
        tone: result.isError ? 'failed' : 'plain',
        call,
      };
    }
    case 'native': {
      const effort = reasoningChangeOf(m.content);
      if (effort !== undefined)
        return { ...row, kind: 'reasoning', summary: `now ${effort}`, tone: 'muted' };
      return { ...row, kind: 'provider', summary: m.provider, tone: 'muted' };
    }
    case 'custom':
      return { ...row, kind: m.tag, summary: '', tone: 'muted' };
  }
}

/** A row for a call the model made that has no result (yet). */
export function pendingRow(call: CallInfo): Row {
  return {
    key: `call-${call.id}`,
    seq: null,
    at: null,
    kind: `… ${call.name}`,
    summary: firstArgument(call.arguments),
    tags: [],
    measure: 'awaiting result',
    tone: 'waiting',
    depth: 0,
    rule: false,
    message: null,
    call,
    compaction: null,
  };
}

const REASONS: { readonly [reason: string]: string } = {
  threshold: 'it grew past its size',
  overflow: 'the provider refused it',
  asked: 'asked',
};

/** A compaction's rule, placed after the message the conversation had reached. */
export function compactionRule(compaction: Compaction): Rule {
  const parts: string[] = ['compacted', compaction.kind];
  if (compaction.tokensBefore > 0) parts.push(`${count(compaction.tokensBefore)} tokens`);
  parts.push(REASONS[compaction.reason] ?? compaction.reason);
  return {
    type: 'rule',
    key: `compaction-${compaction.atSeq}-${compaction.createdAt}`,
    row: {
      key: `compaction-${compaction.atSeq}-${compaction.createdAt}`,
      seq: null,
      at: compaction.createdAt,
      kind: 'context',
      summary: parts.join(' · '),
      tags: [],
      measure: `from ${String(compaction.keepFromSeq)}`,
      tone: 'muted',
      depth: 0,
      rule: true,
      message: null,
      call: null,
      compaction,
    },
  };
}

/** Messages in `seq` order, each once. */
export function dedupe(messages: readonly Message[]): Message[] {
  const bySeq = new Map<number, Message>();
  for (const message of messages) bySeq.set(message.seq, message);
  return [...bySeq.values()].toSorted((a, b) => a.seq - b.seq);
}

/** Whether a message is the model's answer that ended its turn: one with no tool call. */
function endsTurn(message: Message): boolean {
  if (message.message.role !== 'assistant') return false;
  return readResponse(message.message).calls.length === 0;
}

/**
 * Bands and rules for the messages read so far. Messages are given in any order and may repeat;
 * each is shown once. Where the actor stands says how the last band is.
 */
export function buildLog(
  messages: readonly Message[],
  compactions: readonly Compaction[],
  standing: Standing | undefined,
): LogItem[] {
  const sorted = dedupe(messages);

  // Every call a response made, for naming results and finding the unanswered.
  const calls = new Map<string, CallInfo>();
  const answered = new Set<string>();
  for (const message of sorted) {
    const m = message.message;
    if (m.role === 'assistant') {
      for (const call of readResponse(m).calls) {
        calls.set(call.toolCallId, {
          id: call.toolCallId,
          name: call.toolName,
          arguments: call.arguments,
        });
      }
    } else if (m.role === 'tool_result') {
      answered.add(m.toolCallId);
    }
  }

  const groups: Message[][] = [];
  let current: Message[] = [];
  for (const message of sorted) {
    current.push(message);
    if (endsTurn(message)) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length > 0) groups.push(current);

  const working = standing?.status === 'working';
  const lastTurn = standing?.lastTurn ?? null;
  const bands: Band[] = groups.map((group, index) => {
    const last = index === groups.length - 1;
    const rows = group.map((message) => describe(message, calls));
    let tokensIn = 0;
    let tokensOut = 0;
    let models = 0;
    for (const message of group) {
      if (message.message.role !== 'assistant') continue;
      models += 1;
      const usage = metadataOf(message).usage;
      tokensIn += inputTokens(usage) ?? 0;
      tokensOut += usage?.output ?? 0;
    }
    const open = last && !endsTurn(group.at(-1)!);
    // Calls with no result: the turn is waiting on them, or it ended before they came back.
    if (last) {
      for (const message of group) {
        if (message.message.role !== 'assistant') continue;
        for (const call of readResponse(message.message).calls) {
          if (!answered.has(call.toolCallId)) rows.push(pendingRow(calls.get(call.toolCallId)!));
        }
      }
    }
    let status: BandStatus = 'ended';
    let reason: string | null = null;
    if (last && working) status = 'running';
    else if (last && lastTurn !== null && (open || lastTurn.end !== 'ok')) {
      status = lastTurn.end === 'ok' ? 'ended' : lastTurn.end;
      reason = lastTurn.reason ?? null;
    }
    const first = group[0]!;
    const end = group.at(-1)!;
    return {
      type: 'band',
      key: `turn-${first.seq}`,
      turn: index + 1,
      status,
      reason,
      rows,
      startedAt: first.createdAt,
      endedAt: status === 'running' ? null : end.createdAt,
      calls: models,
      tokensIn,
      tokensOut,
      first: first.seq,
      last: end.seq,
    };
  });

  // A compaction comes after the message it reached: inside a band, it is drawn before the band
  // that follows, which is as near as the rows allow.
  const items: LogItem[] = [...bands, ...compactions.map(compactionRule)];
  return items.toSorted((a, b) => placeOf(a) - placeOf(b));
}

function placeOf(item: LogItem): number {
  return item.type === 'band' ? item.first : (item.row.compaction?.atSeq ?? 0) + 0.5;
}

/** Which bands start open: the turn going on, the last turn, and any that failed or was interrupted. */
export function startsOpen(band: Band, last: number | undefined): boolean {
  return band.status !== 'ended' || band.turn === last;
}

/** The band's line after its number: how it ended and why. */
export function bandEnding(band: Band): string {
  if (band.status === 'running') return 'running';
  if (band.reason !== null) return `${band.status} · ${band.reason}`;
  return band.status;
}
