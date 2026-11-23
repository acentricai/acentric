// What a row opens to: a message's content, as text, and from there its JSON.
// Drawn as the reference dashboard draws an opened log entry (`log__detail`),
// with each part under a small label.

import type { Json, Message, Usage } from '@acentric/protocol';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { useEffect, useState, type ReactNode } from 'react';

import { boundedJson } from '../../json-text.ts';
import { fullTime, NOTHING } from '../../format.ts';
import { copyText, JsonBlock, LongText } from '../../ui.tsx';
import { blobUrl } from '../api.ts';
import { usageOf, type Row } from './model.ts';
import { imageSource, messageText, readResponse, readResult } from './read.ts';

type ContentPart = Extract<Message, { role: 'user' }>['content'][number];

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="log__section">
      <p className="log__label">{label}</p>
      <div className="log__section-body">{children}</div>
    </div>
  );
}

/** A record as JSON to copy: whole, or within bounds if it cannot be written whole. */
export function copyJson(record: unknown): string {
  try {
    return JSON.stringify(record, null, 2);
  } catch {
    return boundedJson(record, { maxChars: 2_000_000 }).text;
  }
}

/** JSON in its code block, with the copy button in its corner. The text is made only when copied. */
export function JsonView({ value, label }: { value: unknown; label: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), 1400);
    return () => clearTimeout(timer);
  }, [done]);
  return (
    <div className="json-copy">
      <JsonBlock value={value} />
      <button
        type="button"
        className="icon-button copy-button"
        aria-label={`Copy ${label}`}
        title="Copy"
        data-copied={done || undefined}
        onClick={(event) => {
          event.stopPropagation();
          void copyText(copyJson(value)).then(setDone);
        }}
      >
        {done ? (
          <IconCheck size={14} stroke={2} aria-hidden="true" />
        ) : (
          <IconCopy size={14} stroke={1.75} aria-hidden="true" />
        )}
        <span className="visually-hidden" aria-live="polite">
          {done ? 'Copied' : ''}
        </span>
      </button>
    </div>
  );
}

function Parts({
  parts,
  actor,
  mono = false,
}: {
  parts: readonly ContentPart[];
  /** The actor whose blobs the images are. */
  actor: string;
  mono?: boolean;
}) {
  return (
    <>
      {parts.map((part, index) => {
        if (part.type === 'text') return <LongText key={index} text={part.text} mono={mono} />;
        if (part.type === 'image') {
          const src = imageSource(part, (digest) => blobUrl(actor, digest));
          return src === null ? (
            <span key={index} className="tag">
              image
            </span>
          ) : (
            <img key={index} className="message-image" src={src} alt="image" />
          );
        }
        return (
          <span key={index} className="tag">
            {part.filename ?? 'file'}
          </span>
        );
      })}
    </>
  );
}

export function MessageView({ message, actor }: { message: Message; actor: string }) {
  let body: ReactNode;
  switch (message.role) {
    case 'user':
    case 'system':
    case 'tool_result':
      body = <Parts parts={message.content} actor={actor} mono={message.role === 'tool_result'} />;
      break;
    case 'assistant': {
      const text = messageText(message);
      body =
        text === '' ? (
          <JsonView value={message.content} label="content" />
        ) : (
          <LongText text={text} />
        );
      break;
    }
    case 'native':
    case 'custom':
      body = <span className="note">{NOTHING}</span>;
      break;
  }
  return (
    <div className="message">
      <span className="message__role">{message.role}</span>
      <div className="message__body">{body}</div>
    </div>
  );
}

function UsageView({ usage }: { usage: Usage | undefined }) {
  if (usage === undefined) return <span className="note">{NOTHING}</span>;
  const entries = (
    ['totalInput', 'input', 'cacheRead', 'cacheWrite', 'output', 'reasoning'] as const
  )
    .filter((key) => usage[key] !== undefined)
    .map((key): [string, string] => [key, String(usage[key])]);
  if (usage.cost !== undefined)
    entries.push(['cost', `$${usage.cost.total.toFixed(4)} ${usage.cost.source}`]);
  return (
    <dl className="usage">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Args({ value }: { value: Json | string | undefined }) {
  if (value === undefined) return <span className="note">{NOTHING}</span>;
  if (typeof value === 'string') return <LongText text={value} mono />;
  return <JsonView value={value} label="arguments" />;
}

function Content({ row, actor }: { row: Row; actor: string }) {
  const message = row.message?.message;
  if (row.compaction !== null) {
    return (
      <Section label="compaction">
        <JsonView value={row.compaction} label="compaction" />
      </Section>
    );
  }
  if (message === undefined) {
    return (
      <Section label="arguments">
        <Args value={row.call?.arguments} />
      </Section>
    );
  }
  const usage = row.message === null ? undefined : usageOf(row.message);
  switch (message.role) {
    case 'assistant': {
      const view = readResponse(message);
      return (
        <>
          {view.text !== '' && (
            <Section label="text">
              <LongText text={view.text} />
            </Section>
          )}
          {view.refusals.length > 0 && (
            <Section label="refusal">
              <LongText text={view.refusals.join('\n\n')} />
            </Section>
          )}
          {view.thinking.length > 0 && (
            <Section label="thinking">
              <div className="thinking">
                <LongText text={view.thinking.join('\n\n')} />
              </div>
            </Section>
          )}
          {view.searches.length > 0 && (
            <Section label="web search">
              <LongText text={view.searches.map((search) => search || '(no query)').join('\n')} />
            </Section>
          )}
          {view.calls.length > 0 && (
            <Section label="calls">
              {view.calls.map((call) => (
                <div key={call.toolCallId} className="call">
                  <span className="call__name">{call.toolName}</span>
                  <Args value={call.arguments} />
                </div>
              ))}
            </Section>
          )}
          <Section label="usage">
            <UsageView usage={usage} />
          </Section>
        </>
      );
    }
    case 'tool_result': {
      const result = readResult(message);
      return (
        <>
          <Section label="arguments">
            <Args value={row.call?.arguments} />
          </Section>
          <Section label="result">
            <Parts parts={result.parts} actor={actor} mono />
          </Section>
        </>
      );
    }
    case 'user':
    case 'system':
      return (
        <Section label={message.role === 'system' ? 'notice' : 'message'}>
          <MessageView message={message} actor={actor} />
        </Section>
      );
    default:
      return <JsonView value={message} label="JSON" />;
  }
}

/** A row opened in place: its content, and its JSON a step further. */
export function RecordView({ row, actor }: { row: Row; actor: string }) {
  const [json, setJson] = useState(false);
  const value = row.message ?? row.compaction ?? row.call;
  const label = row.seq === null ? 'JSON' : `message ${String(row.seq)}`;
  return (
    <div className="log__detail">
      {json ? <JsonView value={value} label={label} /> : <Content row={row} actor={actor} />}
      <div className="log__detail-bar">
        {value !== null && (
          <button
            type="button"
            className="chip chip--toggle chip--mono"
            aria-pressed={json}
            onClick={() => setJson((was) => !was)}
          >
            JSON
          </button>
        )}
        {row.at !== null && <span className="note">{fullTime(row.at)}</span>}
      </div>
    </div>
  );
}
