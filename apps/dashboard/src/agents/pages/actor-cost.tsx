// An actor's Cost tab: what it and the actors under it spent; a bar of where its own calls'
// tokens went, and each part of them with what it cost; what it spent on turns and on
// compaction and what the actors under it did; and each of its calls to the model, opened to
// what the model sent back.

import type { Actor, ConversationEntry, Usage } from '@acentric/protocol';
import { IconChevronRight } from '@tabler/icons-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { JsonCode } from '../../code.tsx';
import { count, fullTime } from '../../format.ts';
import { dollars, percent } from '../../llm/format.ts';
import { useUsage } from '../../llm/queries.ts';
import type { ConversationState } from '../conversation/conversation.tsx';
import '../../llm/llm.css';

type Part = 'input' | 'cacheRead' | 'cacheWrite' | 'output';

const PARTS: ReadonlyArray<{ part: Part; name: string; hue: string }> = [
  { part: 'input', name: 'Input', hue: 'var(--chart-1)' },
  { part: 'cacheRead', name: 'Read from cache', hue: 'var(--chart-2)' },
  { part: 'cacheWrite', name: 'Written to cache', hue: 'var(--chart-3)' },
  { part: 'output', name: 'Output', hue: 'var(--chart-4)' },
];

/** A line of the tab: what it is, and its value beside it. */
function Fact({ name, children }: { name: ReactNode; children: ReactNode }) {
  return (
    <div className="actor-fact">
      <dt>{name}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Its own calls to the model, each part of them added up: in tokens, and in dollars. */
function partsOf(calls: readonly ConversationEntry[]) {
  const sums = new Map<Part, { tokens: number; cost: number }>(
    PARTS.map(({ part }) => [part, { tokens: 0, cost: 0 }]),
  );
  for (const entry of calls) {
    const usage: Usage | undefined = entry.completion?.usage;
    if (usage === undefined) continue;
    for (const { part } of PARTS) {
      const sum = sums.get(part);
      if (sum === undefined) continue;
      sum.tokens += usage[part] ?? 0;
      sum.cost += usage.cost?.[part] ?? 0;
    }
  }
  return sums;
}

export function CostTab({
  info,
  conversation,
  reveal,
}: {
  info: Actor;
  conversation: ConversationState;
  /** A call to show: scrolled to, and opened. */
  reveal: { seq: number; at: number } | null;
}) {
  // What it and the actors under it spent; and what it spent itself, by kind of call.
  const tree = useUsage({ root: info.id, by: 'actor' });
  const own = useUsage({ actor: info.id, by: 'kind' });
  const total = tree.data?.total.cost;
  const itself = own.data?.total.cost;
  const ofKind = (kind: string) => own.data?.groups?.find((group) => group.key === kind)?.cost;
  const below = total === undefined || itself === undefined ? undefined : total - itself;
  const read = own.data !== undefined;
  const calls = conversation.items.flatMap((item) =>
    item.kind === 'entry' && item.entry.message.role === 'assistant' ? [item.entry] : [],
  );
  const sums = partsOf(calls);
  const whole = [...sums.values()].reduce((sum, part) => sum + part.tokens, 0);
  return (
    <>
      <section className="actor-side__group" aria-labelledby="actor-cost">
        <h2 className="actor-side__title actor-side__title--unseen" id="actor-cost">
          Cost
        </h2>
        {whole > 0 && (
          <div className="usage-split" role="img" aria-label="Tokens by kind">
            {PARTS.map(({ part, name, hue }) => {
              const value = sums.get(part)?.tokens ?? 0;
              return value === 0 ? null : (
                <span
                  key={part}
                  className="usage-split__part"
                  style={{ flexGrow: value / whole, background: hue }}
                  title={`${name}: ${count(value)}`}
                />
              );
            })}
          </div>
        )}
        <dl className="actor-facts" aria-label="Tokens by kind">
          {PARTS.map(({ part, name, hue }) => {
            const sum = sums.get(part);
            return (
              <Fact
                key={part}
                name={
                  <span className="actor-part">
                    <span className="usage-swatch" style={{ background: hue }} aria-hidden="true" />
                    {name}
                  </span>
                }
              >
                <span className="actor-fact__none">{count(sum?.tokens ?? 0)} · </span>
                {dollars(sum?.cost ?? 0)}
              </Fact>
            );
          })}
        </dl>
      </section>
      <section className="actor-side__group" aria-label="By kind of call">
        <dl className="actor-facts">
          <Fact name="Turns">{dollarsOf(ofKind('turn'), read)}</Fact>
          <Fact name="Compaction">{dollarsOf(ofKind('compaction'), read)}</Fact>
          <Fact name="Subagents">{below === undefined ? '—' : dollars(below)}</Fact>
          <Fact name="Total">{total === undefined ? '—' : dollars(total)}</Fact>
        </dl>
      </section>
      <section className="actor-side__group" aria-labelledby="actor-requests">
        <h2 className="actor-side__title" id="actor-requests">
          LLM Requests
        </h2>
        {calls.length === 0 ? (
          <p className="actor-fact__none actor-tasks__none">No requests yet</p>
        ) : (
          <ul className="actor-tasks">
            {calls.map((entry) => (
              <RequestRow
                key={entry.seq}
                entry={entry}
                reveal={reveal?.seq === entry.seq ? reveal.at : undefined}
              />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/**
 * A call to the model: its response's ID, how much of what it was sent was read from cache, and
 * its cost; opened, each part of its tokens, and all it sent back.
 */
function RequestRow({ entry, reveal }: { entry: ConversationEntry; reveal: number | undefined }) {
  const [open, setOpen] = useState(reveal !== undefined);
  const row = useRef<HTMLLIElement>(null);
  // Asked to be shown: opened, and brought into view.
  useEffect(() => {
    if (reveal === undefined) return;
    setOpen(true);
    requestAnimationFrame(() => row.current?.scrollIntoView?.({ block: 'nearest' }));
  }, [reveal]);
  const message = entry.message;
  const id = message.id ?? `#${String(entry.seq)}`;
  const usage = entry.completion?.usage;
  const sent =
    usage === undefined
      ? undefined
      : (usage.totalInput ?? (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0));
  return (
    <li className="actor-task" data-open={open || undefined} ref={row}>
      <div className="actor-task__head">
        <button
          type="button"
          className="actor-task__open"
          aria-expanded={open}
          onClick={() => setOpen((was) => !was)}
        >
          <IconChevronRight size={14} stroke={1.75} aria-hidden="true" />
          <span className="mono actor-request__id" title={id}>
            {id}
          </span>
        </button>
        <span className="actor-task__when">
          {sent === undefined || sent === 0
            ? '—'
            : `${percent((usage?.cacheRead ?? 0) / sent)} cached`}
        </span>
        <span className="actor-request__cost">
          {usage?.cost === undefined ? '—' : dollars(usage.cost.total)}
        </span>
      </div>
      {open && message.role === 'assistant' && (
        <div className="actor-task__detail actor-request__block">
          {usage !== undefined && (
            <dl className="actor-facts actor-request__parts" aria-label="Tokens by kind">
              <Fact name="Time">{fullTime(entry.createdAt)}</Fact>
              {PARTS.map(({ part, name, hue }) => (
                <Fact
                  key={part}
                  name={
                    <span className="actor-part">
                      <span
                        className="usage-swatch"
                        style={{ background: hue }}
                        aria-hidden="true"
                      />
                      {name}
                    </span>
                  }
                >
                  <span className="actor-fact__none">{count(usage[part] ?? 0)} · </span>
                  {dollars(usage.cost?.[part] ?? 0)}
                </Fact>
              ))}
            </dl>
          )}
          <JsonCode value={message.content} what="what the model sent back" />
        </div>
      )}
    </li>
  );
}

/** What was spent on a kind of call: nothing, once it is read and there was none. */
function dollarsOf(cost: number | undefined, read: boolean): string {
  if (cost !== undefined) return dollars(cost);
  return read ? dollars(0) : '—';
}
