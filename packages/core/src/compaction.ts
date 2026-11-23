// Compaction: what a conversation is replaced with, for the model, once it has grown long.
// Nothing is taken out of the conversation itself: a compaction is a record of what the model
// is sent in place of the older part, and from which message the conversation is sent as it is.
//
// There are three kinds, and an actor's provider says which:
//
//   older    The provider writes the summary itself, on request, and returns one signed block.
//            The block is sent first from then on, and the recent turns follow it as they
//            were. Only a summary the provider wrote lets those turns keep their reasoning.
//   all      The provider compacts all it is sent, and returns one opaque item, which carries
//            what the model knew, its reasoning included. The recent messages of the user are
//            kept before it.
//   summary  The actor's own model is asked to write a summary, as text. For a provider with
//            no compaction of its own, and for when a provider's comes back with nothing.
//
// This file plans a compaction and reads its answer. Making the call, and storing what comes
// of it, is the driver's.

import type { ModelAnswer } from '@acentric/ai';
import type {
  AssistantMessage,
  CompactionKind,
  ContentPart,
  Message,
  UserMessage,
} from '@acentric/protocol';

/** How much of a model's window a conversation may fill before it is compacted, when the agent does not say. */
export const DEFAULT_THRESHOLD_SHARE = 0.8;
/** How many tokens of the recent conversation are kept as they are, when the agent does not say. */
export const DEFAULT_RESERVE = 20_000;
/** A model's window when the list of models does not have it. */
export const DEFAULT_WINDOW = 200_000;
/** How many times a compaction is tried again with a summary of less, before it is given up. */
export const MAX_COMPACTION_TRIES = 3;

/** A message of the conversation as the model is sent it. `seq` is absent for one a compaction put there. */
export type Entry = { readonly message: Message; readonly seq?: number };

/** What a plan needs of the actor's provider: how its answers are read. */
export type Reader = {
  /** What an answer says, and what it called. */
  read(message: AssistantMessage): {
    readonly text: string;
    readonly toolCalls: readonly { readonly name: string; readonly arguments: unknown }[];
  };
  /** What a compaction of the provider's own left in an answer, if it left one thing. */
  compacted?(message: AssistantMessage): AssistantMessage | undefined;
};

/** A compaction that can be asked for: what the model is sent, and how its answer is read. */
export type Plan = {
  readonly kind: CompactionKind;
  readonly messages: readonly Message[];
  /**
   * `provider`: the actor's own call, with its instructions and tools, that asks the provider
   * to compact. `summary`: a call with these instructions and no tools, that asks for text.
   */
  readonly ask:
    { readonly by: 'provider' } | { readonly by: 'summary'; readonly instructions: string };
  /**
   * What stands for the older part once the model has answered, and the place from which the
   * conversation follows it as it is. Throws `NoSummary` when the answer holds none.
   */
  finish(answer: ModelAnswer): { readonly replacement: Message[]; readonly keepFromSeq: number };
};

/** A compaction was answered with no summary. The conversation is as it was. */
export class NoSummary extends Error {
  override readonly name = 'NoSummary';
}

/** What a part that is not text counts as, in tokens. */
const MEDIA_TOKENS = 1000;

/** A message's size, roughly: four characters a token. */
export function estimateTokens(message: Message): number {
  const parts = (content: readonly ContentPart[]): number => {
    let tokens = 0;
    for (const part of content) {
      tokens += part.type === 'text' ? Math.ceil(part.text.length / 4) : MEDIA_TOKENS;
    }
    return tokens;
  };
  switch (message.role) {
    case 'user':
    case 'system':
    case 'tool_result':
      return parts(message.content);
    case 'assistant':
    case 'native':
      // What a provider wrote, as it wrote it.
      return Math.ceil(JSON.stringify(message.content).length / 4);
    default:
      return 0;
  }
}

/** How many tokens a call of a model took in and gave out, as its provider counted them. */
export function tokensOf(
  usage:
    | {
        readonly totalInput?: number | undefined;
        readonly input?: number | undefined;
        readonly output?: number | undefined;
      }
    | undefined,
): number {
  return (usage?.totalInput ?? usage?.input ?? 0) + (usage?.output ?? 0);
}

/** A system message a provider takes as its own, such as one that sets the reasoning level. */
const isProviderSystem = (message: Message): boolean =>
  message.role === 'system' && message.providerOptions !== undefined;

/** The place the kept part starts at: its first message's, or the one after the last when nothing is kept. */
function seqOf(kept: readonly Entry[], nextSeq: number): number {
  return kept.find((entry) => entry.seq !== undefined)?.seq ?? nextSeq;
}

// A provider that compacts the older part

/**
 * Whether the kept part can start at `at`. The message there and the one before it have to
 * be one the model's and one not, or the provider joins the two. A line of the engine's own
 * counts as not the model's: it is sent as a message of the user. A tool's result is never
 * where it starts: it belongs with its call.
 */
function cutsAt(entries: readonly Entry[], at: number): boolean {
  const first = entries[at]?.message;
  const before = entries[at - 1]?.message;
  if (first === undefined || before === undefined) return false;
  // Not inside what a compaction before this one put there.
  if (entries[at]?.seq === undefined) return false;
  if (first.role !== 'user' && first.role !== 'system' && first.role !== 'assistant') return false;
  if (isProviderSystem(first)) return false;
  return (first.role === 'assistant') !== (before.role === 'assistant');
}

/**
 * Where the kept part starts. Walking back from the newest message, the first one that brings
 * the kept part to `reserve` tokens is where to cut, or the nearest point after it where a cut
 * can be made, or else the nearest before. Undefined when all of it fits, or when it can be
 * cut nowhere.
 */
function olderCut(entries: readonly Entry[], reserve: number): number | undefined {
  let tokens = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    tokens += estimateTokens((entries[index] as Entry).message);
    if (tokens < reserve) continue;
    for (let at = Math.max(index, 1); at < entries.length; at += 1) {
      if (cutsAt(entries, at)) return at;
    }
    for (let at = index - 1; at >= 1; at -= 1) if (cutsAt(entries, at)) return at;
    return undefined;
  }
  return undefined;
}

/**
 * A compaction by a provider that summarizes the older part: the recent turns are kept as
 * they are, reasoning included. Undefined when there is nothing to compact: all of it is
 * recent, or it can be cut nowhere.
 *
 * For the reasoning of the kept turns to stay good, the kept part has to follow the older one
 * directly and unchanged, starting where the model's turn and another's change over, and the
 * instructions and tools have to be the same on this call as on the calls around it. It is
 * the actor's own call that asks, so they are.
 */
export function planOlder(
  entries: readonly Entry[],
  reserve: number,
  nextSeq: number,
  reader: Reader,
): Plan | undefined {
  const cut = olderCut(entries, reserve);
  if (cut === undefined) return undefined;
  const older = entries.slice(0, cut);
  const kept = entries.slice(cut);
  // What an earlier compaction left, alone, holds nothing a new one would not.
  if (!older.some((entry) => entry.seq !== undefined)) return undefined;
  return {
    kind: 'older',
    messages: older.map((entry) => entry.message),
    ask: { by: 'provider' },
    finish(answer) {
      // Of the answer only the block is kept, exactly as it came: it is signed.
      const block = reader.compacted?.(answer.message);
      if (block === undefined) {
        throw new NoSummary(
          `The provider wrote no summary: the summarization ended with ${answer.stopReason}`,
        );
      }
      return { replacement: [block], keepFromSeq: seqOf(kept, nextSeq) };
    },
  };
}

// A provider that compacts all it is sent

/** The newest messages of the user that fit in `budget` tokens, whole, in the order they were sent. */
function recentUserMessages(entries: readonly Entry[], budget: number): UserMessage[] {
  const kept: UserMessage[] = [];
  let left = budget;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const { message } = entries[index] as Entry;
    if (message.role !== 'user') continue;
    const tokens = estimateTokens(message);
    if (tokens > left) break;
    kept.unshift(message);
    left -= tokens;
  }
  return kept;
}

/**
 * A compaction by a provider that compacts all it is sent: the call that was about to be
 * made, asking to compact instead of answer. Its one item stands for everything before it, so
 * nothing of the conversation follows it as it was: what is kept is the user's recent
 * messages, before the item.
 */
export function planAll(
  entries: readonly Entry[],
  reserve: number,
  nextSeq: number,
  reader: Reader,
): Plan | undefined {
  if (entries.length === 0) return undefined;
  return {
    kind: 'all',
    messages: entries.map((entry) => entry.message),
    ask: { by: 'provider' },
    finish(answer) {
      // Only the compaction is kept of the answer: nothing else in it is part of the conversation.
      const item = reader.compacted?.(answer.message);
      if (item === undefined) {
        throw new NoSummary(
          'The provider answered a compaction with nothing that stands for the conversation',
        );
      }
      return { replacement: [...recentUserMessages(entries, reserve), item], keepFromSeq: nextSeq };
    },
  };
}

// A written summary

const SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const FORMAT = `## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const FIRST_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

${FORMAT}`;

const UPDATE_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

${FORMAT}`;

const SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;
const SUMMARY_SUFFIX = `
</summary>`;

/** How much of a tool's result the summarizer is shown, in characters. */
const TOOL_RESULT_CHARS = 2000;

const textOf = (parts: readonly ContentPart[]): string =>
  parts.map((part) => (part.type === 'text' ? part.text : `[${part.type}]`)).join('');

/** The summary a message holds, if it is one a compaction left: a written one, or a provider's block that can be read. */
function summaryIn(message: Message | undefined): string | undefined {
  if (message === undefined) return undefined;
  if (message.role === 'user' && message.metadata?.['compaction'] === 'summary') {
    const text = textOf(message.content);
    return text.startsWith(SUMMARY_PREFIX) && text.endsWith(SUMMARY_SUFFIX)
      ? text.slice(SUMMARY_PREFIX.length, text.length - SUMMARY_SUFFIX.length)
      : text;
  }
  if (message.role === 'assistant') {
    for (const block of message.content) {
      if (block['type'] === 'compaction' && typeof block['content'] === 'string') {
        return block['content'];
      }
    }
  }
  return undefined;
}

/**
 * The conversation as text for the summarizer. A model's reasoning is left out: what it said,
 * what it called and what came back say what happened.
 */
function serialize(messages: readonly Message[], reader: Reader): string {
  const parts: string[] = [];
  for (const message of messages) {
    switch (message.role) {
      case 'user':
      case 'system': {
        const text = textOf(message.content);
        if (text !== '') parts.push(`[${message.role === 'user' ? 'User' : 'System'}]: ${text}`);
        break;
      }
      case 'assistant': {
        const { text, toolCalls } = reader.read(message);
        if (text !== '') parts.push(`[Assistant]: ${text}`);
        const calls = toolCalls.map((call) => `${call.name}(${JSON.stringify(call.arguments)})`);
        if (calls.length > 0) parts.push(`[Assistant tool calls]: ${calls.join('; ')}`);
        break;
      }
      case 'tool_result': {
        const text = textOf(message.content);
        if (text === '') break;
        parts.push(
          `[Tool result]: ${
            text.length <= TOOL_RESULT_CHARS
              ? text
              : `${text.slice(0, TOOL_RESULT_CHARS)}\n\n[... ${String(text.length - TOOL_RESULT_CHARS)} more characters truncated]`
          }`,
        );
        break;
      }
      default:
        break;
    }
  }
  return parts.join('\n\n');
}

/**
 * Where the kept part of a written summary starts: the nearest message after `reserve` tokens
 * that a conversation can go on from. A tool's result is never parted from its call. When all
 * of it fits, nothing is cut.
 */
function summaryCut(entries: readonly Entry[], reserve: number): number {
  const startsHere = (entry: Entry | undefined): boolean =>
    entry?.seq !== undefined && entry.message.role !== 'tool_result';
  // A turn starts with what set the model to work: a message, or a line of the engine's own.
  const startsTurn = (entry: Entry | undefined): boolean =>
    entry?.seq !== undefined &&
    (entry.message.role === 'user' ||
      (entry.message.role === 'system' && !isProviderSystem(entry.message)));
  let tokens = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    tokens += estimateTokens((entries[index] as Entry).message);
    if (tokens < reserve) continue;
    // Where a turn starts, so that the summary does not have what was asked and the kept part
    // what was answered. Inside a turn only when the turn is all that is recent.
    for (let at = index; at < entries.length; at += 1) if (startsTurn(entries[at])) return at;
    for (let at = index; at < entries.length; at += 1) if (startsHere(entries[at])) return at;
    // Nothing after it to start from, such as one large tool result: all of it is summarized.
    return entries.length;
  }
  return 0;
}

/**
 * A compaction by a summary the actor's own model writes. A summary an earlier compaction
 * left is updated, not summarized again. `maxChars` is how much of the older part the
 * summarizer is shown, from its end: what is older than that is left out, for a conversation
 * too long to be read whole. Undefined when there is nothing to summarize: all of it is recent.
 */
export function planSummary(
  entries: readonly Entry[],
  reserve: number,
  nextSeq: number,
  reader: Reader,
  maxChars = Number.POSITIVE_INFINITY,
): Plan | undefined {
  const previous = summaryIn(entries[0]?.message);
  const from =
    previous === undefined && entries[0]?.seq !== undefined
      ? 0
      : entries.findIndex((entry) => entry.seq !== undefined);
  const body = from === -1 ? [] : entries.slice(from);
  // What an earlier compaction left that cannot be read, such as an opaque item, stays where
  // it is, before the summary: it still holds what came before it.
  const lead =
    previous === undefined && from > 0 ? entries.slice(0, from).map((entry) => entry.message) : [];
  const cut = summaryCut(body, reserve);
  let earlier = serialize(
    body.slice(0, cut).map((entry) => entry.message),
    reader,
  );
  if (earlier === '') return undefined;
  if (earlier.length > maxChars) {
    earlier = `[... the oldest part of the conversation is left out: it was too long to read ...]\n\n${earlier.slice(-maxChars)}`;
  }
  const kept = body.slice(cut);
  const prompt =
    `<conversation>\n${earlier}\n</conversation>\n\n` +
    (previous === undefined
      ? FIRST_PROMPT
      : `<previous-summary>\n${previous}\n</previous-summary>\n\n${UPDATE_PROMPT}`);
  return {
    kind: 'summary',
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    ask: { by: 'summary', instructions: SYSTEM_PROMPT },
    finish(answer) {
      if (answer.stopReason !== 'stop') {
        throw new NoSummary(
          `The summarizer did not write a summary: ${
            answer.stopReason === 'length'
              ? 'it reached its output limit, so the summary is not whole'
              : `it ended with ${answer.stopReason}`
          }`,
        );
      }
      const summary = reader.read(answer.message).text.trim();
      if (summary === '') throw new NoSummary('The summarizer answered with no text');
      const message: UserMessage = {
        role: 'user',
        content: [{ type: 'text', text: SUMMARY_PREFIX + summary + SUMMARY_SUFFIX }],
        metadata: { compaction: 'summary' },
      };
      return { replacement: [...lead, message], keepFromSeq: seqOf(kept, nextSeq) };
    },
  };
}

/** The size a conversation may reach, and how much of its end is kept, for a model. */
export function compactionNumbers(
  given:
    { readonly threshold?: number | undefined; readonly reserve?: number | undefined } | undefined,
  model:
    | {
        readonly contextWindow?: number;
        /** The size from which every token of a call costs more, where the model has one and its calls are paid by the token. */
        readonly dearerAbove?: number;
      }
    | undefined,
): { readonly threshold: number; readonly reserve: number; readonly window: number } {
  const window = model?.contextWindow ?? DEFAULT_WINDOW;
  const share = Math.floor(window * DEFAULT_THRESHOLD_SHARE);
  const dearer = model?.dearerAbove;
  return {
    // Before the conversation reaches a size its every token costs more at, where there is one.
    threshold: given?.threshold ?? (dearer === undefined ? share : Math.min(share, dearer)),
    reserve: given?.reserve ?? DEFAULT_RESERVE,
    window,
  };
}
