// An actor's whole conversation, as it is written: what it was sent, what the model answered and
// thought, the tools it called with what they gave back, the engine's notices, and where the
// conversation was compacted. It follows the actor live, and keeps to the end while the reader
// is there.

import type { Compaction, ConversationEntry, Json, Message } from '@acentric/protocol';
import { IconAlertTriangle, IconChevronRight, IconSearch } from '@tabler/icons-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { JsonCode } from '../../code.tsx';
import { clock, count, longTime } from '../../format.ts';
import { displayText } from '../../machines/text.tsx';
import { CopyButton } from '../../machines/ui.tsx';
import { Markdown } from '../../markdown.tsx';
import { blobUrl, engine } from '../api.ts';
import {
  firstArgument,
  imageSource,
  inputTokens,
  messageText,
  partsText,
  readResponse,
  readResult,
  type ToolCall,
} from '../log/read.ts';
import { followConversation, type Standing } from '../log/stream.ts';
import { useCompactions } from '../queries.ts';
import './conversation.css';

/** What the engine keeps of a message besides it: in its metadata. */
type Meta = {
  readonly compaction?: string;
  readonly notice?: { readonly problem?: string };
};
const metaOf = (entry: ConversationEntry): Meta =>
  (entry.message.metadata ?? {}) as unknown as Meta;

/** A tool call, with its result once it is in. */
type Call = { readonly call: ToolCall; result: ConversationEntry | null };

export type Item =
  | { readonly kind: 'entry'; readonly entry: ConversationEntry; readonly calls: readonly Call[] }
  | { readonly kind: 'compaction'; readonly compaction: Compaction; readonly to?: number };

/**
 * The conversation as it is drawn: each message once, in order, a tool's result in the card of
 * the call that asked for it, and each compaction after the message it reached.
 */
function itemsOf(entries: readonly ConversationEntry[], compactions: readonly Compaction[]) {
  const sorted = [...new Map(entries.map((entry) => [entry.seq, entry])).values()].toSorted(
    (a, b) => a.seq - b.seq,
  );
  const calls = new Map<string, Call>();
  const items: Item[] = [];
  const after = new Map<number, Compaction[]>();
  for (const compaction of compactions) {
    after.set(compaction.atSeq, [...(after.get(compaction.atSeq) ?? []), compaction]);
  }
  for (const entry of sorted) {
    const { message } = entry;
    if (message.role === 'tool_result') {
      const found = calls.get(message.toolCallId);
      // A result is shown with its call; one whose call is not read is shown alone.
      if (found !== undefined) found.result = entry;
      else items.push({ kind: 'entry', entry, calls: [] });
    } else if (message.role === 'assistant') {
      const own = readResponse(message).calls.map((call) => ({ call, result: null }));
      for (const one of own) calls.set(one.call.toolCallId, one);
      items.push({ kind: 'entry', entry, calls: own });
    } else {
      items.push({ kind: 'entry', entry, calls: [] });
    }
    for (const compaction of after.get(entry.seq) ?? [])
      items.push({ kind: 'compaction', compaction });
  }
  // How large it was after: what the next call to the model was sent, as its provider counted it.
  return items.map((item, index) => {
    if (item.kind !== 'compaction') return item;
    const next = items
      .slice(index + 1)
      .find((later) => later.kind === 'entry' && later.entry.completion?.usage !== undefined);
    const to = next?.kind === 'entry' ? inputTokens(next.entry.completion?.usage) : undefined;
    return to === undefined ? item : { ...item, to };
  });
}

export type ConversationState = ReturnType<typeof useConversation>;

/**
 * How large the conversation is now, in tokens, as near as it is known: what the last call to
 * the model was sent and wrote back. Unknown before its first call, and after a compaction until
 * the next one.
 */
export function contextOf(items: readonly Item[]): number | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item === undefined || item.kind === 'compaction') return undefined;
    const usage = item.entry.completion?.usage;
    const sent = inputTokens(usage);
    if (sent !== undefined) return sent + (usage?.output ?? 0);
  }
  return undefined;
}

/** Its messages from the first, then each as it is written, and where it stands. */
export function useConversation(actor: string) {
  const [entries, setEntries] = useState<readonly ConversationEntry[]>([]);
  const [standing, setStanding] = useState<Standing | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const compactions = useCompactions(actor);
  useEffect(() => {
    const abort = new AbortController();
    void followConversation({
      open: (after, signal) => engine.events(actor, after, signal),
      after: 0,
      signal: abort.signal,
      onMessages: (fresh) => setEntries((was) => [...was, ...fresh]),
      onStanding: (next) => {
        setStanding(next);
        // The engine says where the actor stands after the messages it had: those are all in.
        setReady(true);
      },
      onState: (state) => {
        if (state === 'ended') setReady(true);
      },
    }).catch(() => setReady(true));
    return () => abort.abort();
  }, [actor]);
  // A compaction is not a message: it is read again when where the actor stands changes.
  const refetch = compactions.refetch;
  useEffect(() => {
    if (standing !== undefined) void refetch();
  }, [standing, refetch]);
  const items = useMemo(
    () => itemsOf(entries, compactions.data?.items ?? []),
    [entries, compactions.data],
  );
  return { items, standing, ready };
}

export function Conversation({
  actor,
  conversation,
}: {
  actor: string;
  conversation: ConversationState;
}) {
  const { items, standing, ready } = conversation;
  // At the end, the view keeps to it as messages join; scrolled up, it stays where it is.
  const box = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const scrolled = () => {
    const el = box.current;
    if (el !== null) atEnd.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 80;
  };
  useLayoutEffect(() => {
    const el = box.current;
    if (ready && atEnd.current && el !== null) el.scrollTop = el.scrollHeight;
  }, [items, standing, ready]);

  if (!ready && items.length === 0) {
    return (
      <div className="skeleton convo__loading" role="status" aria-label="Loading the conversation">
        <span className="skeleton__line" />
        <span className="skeleton__line" />
        <span className="skeleton__line" />
      </div>
    );
  }
  const failed = standing?.lastTurn?.end === 'failed' ? standing.lastTurn : null;
  return (
    <div className="convo" role="log" aria-label="Conversation" ref={box} onScroll={scrolled}>
      {items.length === 0 && <p className="convo__empty">Nothing said yet</p>}
      {items.map((item) =>
        item.kind === 'compaction' ? (
          <CompactionLine
            key={`c-${String(item.compaction.atSeq)}-${String(item.compaction.createdAt)}`}
            compaction={item.compaction}
            {...(item.to === undefined ? {} : { to: item.to })}
          />
        ) : (
          <EntryView key={item.entry.seq} entry={item.entry} calls={item.calls} actor={actor} />
        ),
      )}
      {standing?.status === 'working' && (
        <div className="convo__working" role="status">
          <span className="convo__working-dot" aria-hidden="true" />
          Working
        </div>
      )}
      {failed !== null && (
        <div className="convo__failed" role="alert">
          <IconAlertTriangle size={15} stroke={1.75} aria-hidden="true" />
          <span>
            The turn failed
            {failed.reason === undefined ? '' : `: ${failed.reason}`}
          </span>
        </div>
      )}
    </div>
  );
}

/** When it was written: the time, and the whole date on hover. */
const When = ({ at }: { at: number }) => (
  <time className="convo__time" dateTime={new Date(at).toISOString()} title={longTime(at)}>
    {clock(at)}
  </time>
);

function EntryView({
  entry,
  calls,
  actor,
}: {
  entry: ConversationEntry;
  calls: readonly Call[];
  actor: string;
}) {
  const { message } = entry;
  const left = entry.leftOut === true;
  const body = (() => {
    switch (message.role) {
      case 'user':
        return metaOf(entry).compaction === 'summary' ? (
          <Notice title="Notice" text={messageText(message)} at={entry.createdAt} />
        ) : (
          <Said entry={entry} message={message} actor={actor} />
        );
      case 'system':
        return <SystemLine entry={entry} message={message} />;
      case 'assistant':
        return <Answer entry={entry} message={message} calls={calls} />;
      case 'tool_result':
        // One whose call was not read.
        return (
          <Calls
            calls={[
              {
                call: { toolCallId: message.toolCallId, toolName: message.toolName, arguments: {} },
                result: entry,
              },
            ]}
          />
        );
      case 'native':
        return <NativeLine entry={entry} items={message.content} />;
      case 'custom':
        return (
          <Notice
            title="Notice"
            text={JSON.stringify(message.data, null, 2)}
            at={entry.createdAt}
          />
        );
    }
  })();
  return (
    <div
      className="convo__entry"
      id={`seq-${String(entry.seq)}`}
      data-left-out={left || undefined}
      title={left ? 'Left out: no longer sent to the model' : undefined}
    >
      {body}
    </div>
  );
}

/** What it was sent from outside, or by another actor: who, when, and what. */
function Said({
  entry,
  message,
  actor,
}: {
  entry: ConversationEntry;
  message: Extract<Message, { role: 'user' }>;
  actor: string;
}) {
  const text = partsText(message.content);
  const images = message.content.flatMap((part) => {
    const source = imageSource(part, (digest) => blobUrl(actor, digest));
    return source === null ? [] : [source];
  });
  const files = message.content.filter((part) => part.type === 'file').length;
  const type = entry.input?.type;
  return (
    <div className="convo__said">
      <div className="convo__bubble">
        {text !== '' && <p className="convo__text">{displayText(text, true)}</p>}
        {images.length > 0 && (
          <div className="convo__images">
            {images.map((source, index) => (
              <a key={index} href={source} target="_blank" rel="noopener noreferrer">
                <img src={source} alt="" className="convo__image" />
              </a>
            ))}
          </div>
        )}
        {files > 0 && (
          <span className="convo__muted">{files === 1 ? '1 file' : `${String(files)} files`}</span>
        )}
        {text === '' && images.length === 0 && files === 0 && (
          <span className="convo__muted">Nothing in it</span>
        )}
      </div>
      <div className="convo__actions">
        {entry.leftOut === true && <span className="convo__tag">left out</span>}
        <When at={entry.createdAt} />
        <span>{type === undefined || type === 'message' ? 'Input' : `Input · ${type}`}</span>
        {text !== '' && <CopyButton value={text} what="the input" />}
      </div>
    </div>
  );
}

/** A model's answer: what it thought, what it said, what it searched, and the tools it called. */
function Answer({
  entry,
  message,
  calls,
}: {
  entry: ConversationEntry;
  message: Extract<Message, { role: 'assistant' }>;
  calls: readonly Call[];
}) {
  const view = readResponse(message);
  const said = view.text !== '';
  return (
    <div className="convo__answer">
      {said && <Markdown text={view.text} className="convo__markdown" />}
      {view.refusals.map((refusal, index) => (
        <p key={index} className="convo__refusal">
          {displayText(refusal === '' ? 'It refused.' : refusal, true)}
        </p>
      ))}
      {view.searches.map((search, index) => (
        <p key={index} className="convo__search">
          <IconSearch size={13} stroke={1.75} aria-hidden="true" />
          Searched the web{search === '' ? '' : ` for ${search}`}
        </p>
      ))}
      {calls.length > 0 && <Calls calls={calls} />}
      {!said &&
        view.thinking.length === 0 &&
        calls.length === 0 &&
        view.refusals.length === 0 &&
        view.searches.length === 0 && (
          <p className="convo__muted">
            {entry.completion === undefined
              ? 'Nothing said'
              : `Stopped: ${entry.completion.stopReason}`}
          </p>
        )}
      {entry.leftOut === true && <span className="convo__tag convo__left-out">left out</span>}
    </div>
  );
}

/** How a call went: under way until its result is in, and failed if the tool said so. */
function stateOf(result: ConversationEntry | null): 'running' | 'failed' | 'done' {
  if (result === null) return 'running';
  const message = result.message;
  if (message.role !== 'tool_result' && message.role !== 'native') return 'done';
  return readResult(message).isError ? 'failed' : 'done';
}

/** The tools a turn called: a row each. */
const Calls = ({ calls }: { calls: readonly Call[] }) => (
  <div className="convo__call-list">
    {calls.map((one) => (
      <CallRow key={one.call.toolCallId} call={one.call} result={one.result} />
    ))}
  </div>
);

/** A tool call: its name and what it is about; opened, what went in and what came out. */
function CallRow({ call, result }: { call: ToolCall; result: ConversationEntry | null }) {
  const [open, setOpen] = useState(false);
  const read =
    result !== null && (result.message.role === 'tool_result' || result.message.role === 'native')
      ? readResult(result.message)
      : null;
  const state = stateOf(result);
  const about = firstArgument(call.arguments);
  return (
    <div className="convo__call" data-state={state} data-open={open || undefined}>
      <button
        type="button"
        className="convo__call-head"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <span className="convo__call-name">{call.toolName}</span>
        {about !== '' && <span className="convo__call-about mono">{about}</span>}
        <IconChevronRight size={13} stroke={1.75} aria-hidden="true" className="convo__chevron" />
        {state !== 'done' && <span className="convo__call-state">{state}</span>}
      </button>
      {open && (
        <div className="convo__call-body">
          {typeof call.arguments === 'string' ? (
            <Out text={call.arguments} what="the arguments" />
          ) : (
            <JsonCode value={call.arguments as Json} what="the arguments" />
          )}
          {read !== null &&
            (read.native !== null ? (
              <JsonCode value={read.native as Json} what="the result" />
            ) : (
              <Out
                text={read.text === '' ? 'Nothing' : read.text}
                what={read.isError ? 'the error' : 'the result'}
                error={read.isError}
              />
            ))}
        </div>
      )}
    </div>
  );
}

/** What a tool gave back, as it wrote it, with a copy of it. */
function Out({ text, what, error = false }: { text: string; what: string; error?: boolean }) {
  return (
    <div className="json convo__result">
      <pre className="json__code convo__out-text" data-error={error || undefined}>
        {displayText(text, true)}
      </pre>
      <CopyButton value={text} what={what} />
    </div>
  );
}

/** The engine's own line: a task that ended, another agent's message, or a note. */
function SystemLine({
  entry,
  message,
}: {
  entry: ConversationEntry;
  message: Extract<Message, { role: 'system' }>;
}) {
  const config = message.providerOptions?.['output_config'];
  const effort =
    typeof config === 'object' && config !== null && !Array.isArray(config)
      ? (config as { effort?: unknown }).effort
      : undefined;
  if (typeof effort === 'string') {
    return <Quiet at={entry.createdAt}>Reasoning set to {effort}</Quiet>;
  }
  const text = messageText(message);
  const title = noticeTitle(text);
  const problem = metaOf(entry).notice?.problem;
  return (
    <Notice
      title={title}
      text={text}
      at={entry.createdAt}
      {...(problem === undefined ? {} : { problem })}
    />
  );
}

/**
 * What a notice is called under it: Notice, and the task it tells of or the actor it is from, out
 * of the tag it opens with: `<task id="b3">`, `<message from="worker">`.
 */
function noticeTitle(text: string): string {
  const open = /^<([a-z-]+)([^>]*)>/.exec(text.trim());
  const attribute = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(open?.[2] ?? '')?.[1];
  const of = open?.[1] === 'task' ? attribute('id') : (attribute('from') ?? attribute('name'));
  return of === undefined || of === '' ? 'Notice' : `Notice · ${of}`;
}

/** A provider's own item: a change of reasoning, or something only it reads. */
function NativeLine({ entry, items }: { entry: ConversationEntry; items: readonly Json[] }) {
  const item = items.length === 1 ? items[0] : undefined;
  const reasoning =
    typeof item === 'object' &&
    item !== null &&
    !Array.isArray(item) &&
    item['type'] === 'configuration_update'
      ? item['reasoning']
      : undefined;
  const effort =
    typeof reasoning === 'object' && reasoning !== null && !Array.isArray(reasoning)
      ? reasoning['effort']
      : undefined;
  if (typeof effort === 'string') {
    return <Quiet at={entry.createdAt}>Reasoning set to {effort}</Quiet>;
  }
  return <Notice title="Notice" text={JSON.stringify(items, null, 2)} at={entry.createdAt} />;
}

/**
 * What a notice says inside the tag it is wrapped in, `<task …>` or `<message …>`: the tag is what
 * its title already names. The copy is of all of it.
 */
function noticeBody(text: string): string {
  const wrapped = /^\s*<([a-z-]+)(?:\s[^>]*)?>\n?([\s\S]*?)\n?<\/\1>\s*$/.exec(text);
  const inside = wrapped?.[2]?.trim();
  return inside === undefined || inside === '' ? text : inside;
}

/** A line of the engine's: all it says, in the middle, and under it on hover, when and what. */
function Notice({
  title,
  text,
  at,
  problem,
}: {
  title: string;
  text: string;
  at: number;
  problem?: string;
}) {
  return (
    <div className="convo__notice" data-problem={problem !== undefined || undefined}>
      <div className="convo__bubble">
        <p className="convo__text">{displayText(noticeBody(text), true)}</p>
      </div>
      <div className="convo__actions">
        <When at={at} />
        <span>{title}</span>
        {problem !== undefined && <span className="convo__problem">{problem}</span>}
        <CopyButton value={text} what="the notice" />
      </div>
    </div>
  );
}

/** A line that says one thing, quietly. */
const Quiet = ({ at, children }: { at: number; children: ReactNode }) => (
  <div className="convo__quiet">
    <span>{children}</span>
    <When at={at} />
  </div>
);

/** Where the conversation was compacted: a rule across it, and how large it was before and after. */
function CompactionLine({ compaction, to }: { compaction: Compaction; to?: number }) {
  const sized = compaction.tokensBefore > 0 && to !== undefined;
  return (
    <div className="convo__rule" role="separator">
      <span>
        {sized
          ? `Compacted from ${count(compaction.tokensBefore)} to ${count(to)} tokens`
          : 'Compacted'}
      </span>
    </div>
  );
}
