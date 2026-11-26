// An actor's whole conversation, as it is written: what it was sent, what the model answered and
// thought, the tools it called with what they gave back, the engine's notices, and where the
// conversation was compacted. It follows the actor live, and keeps to the end while the reader
// is there.

import type { Compaction, ConversationEntry, Json, Message } from '@acentric/protocol';
import {
  IconAlertTriangle,
  IconArrowsMinimize,
  IconBolt,
  IconChevronRight,
  IconInfoCircle,
  IconMessage2,
  IconSearch,
  IconSparkles,
} from '@tabler/icons-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { JsonCode } from '../../code.tsx';
import { clock, count, longTime, tokens } from '../../format.ts';
import { displayText } from '../../machines/text.tsx';
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

type Item =
  | { readonly kind: 'entry'; readonly entry: ConversationEntry; readonly calls: readonly Call[] }
  | { readonly kind: 'compaction'; readonly compaction: Compaction };

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
  return items;
}

/** Its messages from the first, then each as it is written, and where it stands. */
function useConversation(actor: string) {
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

export function Conversation({ actor }: { actor: string }) {
  const { items, standing, ready } = useConversation(actor);
  // At the end, the view keeps to it as messages join; scrolled up, it stays where it is.
  const atEnd = useRef(true);
  useEffect(() => {
    const scrolled = () => {
      atEnd.current =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 80;
    };
    window.addEventListener('scroll', scrolled, { passive: true });
    return () => window.removeEventListener('scroll', scrolled);
  }, []);
  useLayoutEffect(() => {
    if (ready && atEnd.current) window.scrollTo({ top: document.documentElement.scrollHeight });
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
    <div className="convo" role="log" aria-label="Conversation">
      {items.length === 0 && <p className="convo__empty">Nothing said yet</p>}
      {items.map((item) =>
        item.kind === 'compaction' ? (
          <CompactionLine
            key={`c-${String(item.compaction.atSeq)}-${String(item.compaction.createdAt)}`}
            compaction={item.compaction}
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
          <Notice
            icon={<IconArrowsMinimize size={14} stroke={1.75} aria-hidden="true" />}
            title="Summary of the conversation before"
            text={messageText(message)}
            at={entry.createdAt}
          />
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
          <div className="convo__calls">
            <CallCard
              call={{ toolCallId: message.toolCallId, toolName: message.toolName, arguments: {} }}
              result={entry}
            />
          </div>
        );
      case 'native':
        return <NativeLine entry={entry} items={message.content} provider={message.provider} />;
      case 'custom':
        return (
          <Notice
            icon={<IconInfoCircle size={14} stroke={1.75} aria-hidden="true" />}
            title={message.tag}
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
      <div className="convo__head">
        <IconMessage2 size={14} stroke={1.75} aria-hidden="true" />
        <span className="convo__who">{type === undefined ? 'User' : inputName(type)}</span>
        {entry.leftOut === true && <span className="convo__tag">left out</span>}
        <When at={entry.createdAt} />
      </div>
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
    </div>
  );
}

/** `message` is a Message; any other type is written as it is named. */
const inputName = (type: string) => (type === 'message' ? 'Message' : type);

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
  const usage = entry.completion?.usage;
  const used = usage === undefined ? '' : tokens(inputTokens(usage), usage.output);
  return (
    <div className="convo__answer">
      <div className="convo__head">
        <IconSparkles size={14} stroke={1.75} aria-hidden="true" />
        <span className="convo__who">Assistant</span>
        <span className="convo__muted mono">{message.model}</span>
        {used !== '' && <span className="convo__muted">{used}</span>}
        {entry.leftOut === true && <span className="convo__tag">left out</span>}
        <When at={entry.createdAt} />
      </div>
      {view.thinking.length > 0 && <Thinking text={view.thinking.join('\n\n')} />}
      {view.text !== '' && <Markdown text={view.text} className="convo__markdown" />}
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
      {calls.length > 0 && (
        <div className="convo__calls">
          {calls.map((one) => (
            <CallCard key={one.call.toolCallId} call={one.call} result={one.result} />
          ))}
        </div>
      )}
      {view.text === '' &&
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
    </div>
  );
}

/** What the model thought before it answered: folded, as it is long and not for the reader. */
function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="convo__thinking" data-open={open || undefined}>
      <button
        type="button"
        className="convo__toggle"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <IconChevronRight size={13} stroke={1.75} aria-hidden="true" />
        Thought
      </button>
      {open && <p className="convo__thought">{displayText(text, true)}</p>}
    </div>
  );
}

/** A tool call: its name and what it is about, how it went, and opened, what went in and out. */
function CallCard({ call, result }: { call: ToolCall; result: ConversationEntry | null }) {
  const [open, setOpen] = useState(false);
  const read =
    result !== null && (result.message.role === 'tool_result' || result.message.role === 'native')
      ? readResult(result.message)
      : null;
  const state = read === null ? 'running' : read.isError ? 'failed' : 'done';
  const about = firstArgument(call.arguments);
  return (
    <div className="convo__call" data-state={state} data-open={open || undefined}>
      <button
        type="button"
        className="convo__call-head"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <IconChevronRight size={13} stroke={1.75} aria-hidden="true" className="convo__chevron" />
        <IconBolt size={13} stroke={1.75} aria-hidden="true" />
        <span className="convo__call-name mono">{call.toolName}</span>
        {about !== '' && <span className="convo__call-about mono">{about}</span>}
        <span className="convo__call-state">
          {state === 'running' ? 'running' : state === 'failed' ? 'failed' : ''}
        </span>
      </button>
      {open && (
        <div className="convo__call-body">
          <span className="convo__label">Arguments</span>
          {typeof call.arguments === 'string' ? (
            <pre className="convo__out">{displayText(call.arguments, true)}</pre>
          ) : (
            <JsonCode value={call.arguments as Json} what="the arguments" />
          )}
          {read !== null && (
            <>
              <span className="convo__label">{read.isError ? 'Error' : 'Result'}</span>
              {read.native !== null ? (
                <JsonCode value={read.native as Json} what="the result" />
              ) : (
                <pre className="convo__out" data-error={read.isError || undefined}>
                  {read.text === '' ? 'Nothing' : displayText(read.text, true)}
                </pre>
              )}
            </>
          )}
        </div>
      )}
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
      icon={<IconInfoCircle size={14} stroke={1.75} aria-hidden="true" />}
      title={title}
      text={text}
      at={entry.createdAt}
      {...(problem === undefined ? {} : { problem })}
    />
  );
}

/**
 * What one of the engine's lines is about, from the tag it opens with: `<task id="b3"
 * status="done">` is a task that ended, `<message from="worker">` another actor's message.
 */
function noticeTitle(text: string): string {
  const open = /^<([a-z-]+)([^>]*)>/.exec(text.trim());
  const tag = open?.[1];
  const attribute = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(open?.[2] ?? '')?.[1];
  if (tag === 'task') {
    const id = attribute('id');
    const status = attribute('status');
    return [`Task${id === undefined ? '' : ` ${id}`}`, status].filter(Boolean).join(' · ');
  }
  if (tag === 'message' || tag === 'agent') {
    const from = attribute('from') ?? attribute('name');
    return from === undefined ? 'From another agent' : `Message from ${from}`;
  }
  if (tag === 'compacted') return 'The conversation was compacted';
  return 'Notice';
}

/** A provider's own item: a change of reasoning, or something only it reads. */
function NativeLine({
  entry,
  items,
  provider,
}: {
  entry: ConversationEntry;
  items: readonly Json[];
  provider: string;
}) {
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
  return (
    <Notice
      icon={<IconInfoCircle size={14} stroke={1.75} aria-hidden="true" />}
      title={`An item of ${provider}’s own`}
      text={JSON.stringify(items, null, 2)}
      at={entry.createdAt}
    />
  );
}

/** A line of the engine's, folded to its title: opened, all it says. */
function Notice({
  icon,
  title,
  text,
  at,
  problem,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  at: number;
  problem?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="convo__notice"
      data-open={open || undefined}
      data-problem={problem !== undefined || undefined}
    >
      <button
        type="button"
        className="convo__toggle"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <IconChevronRight size={13} stroke={1.75} aria-hidden="true" className="convo__chevron" />
        {icon}
        <span>{title}</span>
        {problem !== undefined && <span className="convo__problem">{problem}</span>}
        <When at={at} />
      </button>
      {open && <pre className="convo__out">{displayText(text, true)}</pre>}
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

const REASONS: { readonly [reason: string]: string } = {
  threshold: 'it grew past its size',
  overflow: 'the provider refused it',
  asked: 'asked for',
};

/** Where the conversation was compacted: a rule across it. */
function CompactionLine({ compaction }: { compaction: Compaction }) {
  const size = compaction.tokensBefore > 0 ? ` from ${count(compaction.tokensBefore)} tokens` : '';
  return (
    <div className="convo__rule" role="separator">
      <span>
        Compacted{size} · {REASONS[compaction.reason] ?? compaction.reason}
      </span>
    </div>
  );
}
