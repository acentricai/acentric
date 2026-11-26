// An actor's Cost tab: what it and the actors under it spent, each call to the model it made
// as a point on a line of input, output and cache, in dollars or in tokens, and below, each of
// those calls, opened to what the model sent back.

import type { Actor, ConversationEntry, Usage } from '@acentric/protocol';
import { IconChevronRight } from '@tabler/icons-react';
import { useState, type PointerEvent, type ReactNode } from 'react';

import { JsonCode } from '../../code.tsx';
import { clock, count } from '../../format.ts';
import { dollars } from '../../llm/format.ts';
import { useUsage } from '../../llm/queries.ts';
import { Segmented } from '../../ui.tsx';
import type { ConversationState } from '../conversation/conversation.tsx';
import '../../llm/llm.css';

type Measure = 'cost' | 'tokens';

const MEASURES: ReadonlyArray<readonly [Measure, string]> = [
  ['cost', 'Cost'],
  ['tokens', 'Tokens'],
];

type Part = 'input' | 'output' | 'cacheRead' | 'cacheWrite';

const PARTS: ReadonlyArray<{ part: Part; name: string; hue: string }> = [
  { part: 'input', name: 'Input', hue: 'var(--chart-1)' },
  { part: 'output', name: 'Output', hue: 'var(--chart-2)' },
  { part: 'cacheRead', name: 'Cache read', hue: 'var(--chart-3)' },
  { part: 'cacheWrite', name: 'Cache write', hue: 'var(--chart-4)' },
];

/** A part of a call: in dollars, or in tokens; nothing where it is not known. */
function partOf(usage: Usage | undefined, part: Part, measure: Measure): number {
  if (usage === undefined) return 0;
  return (measure === 'cost' ? usage.cost?.[part] : usage[part]) ?? 0;
}

/** All of a call, as it is shown on its row. */
function wholeOf(usage: Usage | undefined, measure: Measure): string {
  if (usage === undefined) return '—';
  if (measure === 'cost') return usage.cost === undefined ? '—' : dollars(usage.cost.total);
  const sent =
    usage.totalInput ?? (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  return `${count(sent)} in · ${count(usage.output ?? 0)} out`;
}

const written = (value: number, measure: Measure) =>
  measure === 'cost' ? dollars(value) : count(value);

/** A line of the tab: what it is, and its value beside it. */
function Fact({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="actor-fact">
      <dt>{name}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function CostTab({ info, conversation }: { info: Actor; conversation: ConversationState }) {
  const [measure, setMeasure] = useState<Measure>('cost');
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
  return (
    <>
      <section className="actor-side__group" aria-labelledby="actor-cost">
        <h2 className="actor-side__title" id="actor-cost">
          Cost
        </h2>
        <p className="actor-cost__total">{total === undefined ? '—' : dollars(total)}</p>
        <dl className="actor-facts">
          <Fact name="Turns">{dollarsOf(ofKind('turn'), read)}</Fact>
          <Fact name="Compaction">{dollarsOf(ofKind('compaction'), read)}</Fact>
          <Fact name="Subagents">{below === undefined ? '—' : dollars(below)}</Fact>
        </dl>
      </section>
      <section className="actor-side__group" aria-label="By call">
        <Segmented label="Measure" value={measure} options={MEASURES} onChange={setMeasure} />
        <CallChart calls={calls} measure={measure} />
      </section>
      <section className="actor-side__group" aria-labelledby="actor-requests">
        <h2 className="actor-side__title" id="actor-requests">
          LLM Requests
        </h2>
        {calls.length === 0 ? (
          <p className="actor-fact__none actor-tasks__none">No requests yet</p>
        ) : (
          <ul className="actor-tasks">
            {calls.toReversed().map((entry) => (
              <RequestRow key={entry.seq} entry={entry} measure={measure} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

const WIDTH = 300;
const HEIGHT = 120;

/** Each call to the model, oldest at the left: a line for each part of it. */
function CallChart({ calls, measure }: { calls: readonly ConversationEntry[]; measure: Measure }) {
  const [hover, setHover] = useState<number | null>(null);
  if (calls.length === 0) return null;
  const values = PARTS.map(({ part }) =>
    calls.map((entry) => partOf(entry.completion?.usage, part, measure)),
  );
  const top = Math.max(...values.flat(), 0);
  const x = (index: number) =>
    calls.length === 1 ? WIDTH / 2 : (index / (calls.length - 1)) * WIDTH;
  const y = (value: number) => (top === 0 ? HEIGHT : HEIGHT - (value / top) * HEIGHT);
  const onMove = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const at = ((event.clientX - box.left) / box.width) * (calls.length - 1);
    setHover(Math.min(calls.length - 1, Math.max(0, Math.round(at))));
  };
  const shown = hover === null ? undefined : calls[hover];
  return (
    <div className="actor-chart">
      <div className="actor-chart__plot">
        <svg
          viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`${measure === 'cost' ? 'Cost' : 'Tokens'} of each call to the model`}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          <line className="actor-chart__base" x1={0} x2={WIDTH} y1={HEIGHT} y2={HEIGHT} />
          {hover !== null && (
            <line className="actor-chart__at" x1={x(hover)} x2={x(hover)} y1={0} y2={HEIGHT} />
          )}
          {PARTS.map(({ part, hue }, index) => (
            <polyline
              key={part}
              className="actor-chart__line"
              stroke={hue}
              points={(values[index] ?? []).map((value, at) => `${x(at)},${y(value)}`).join(' ')}
            />
          ))}
        </svg>
      </div>
      <ul className="actor-chart__legend" aria-live="polite">
        {PARTS.map(({ part, name, hue }) => (
          <li key={part}>
            <span className="usage-swatch" style={{ background: hue }} aria-hidden="true" />
            {name}
            {shown !== undefined && (
              <span className="actor-chart__value">
                {written(partOf(shown.completion?.usage, part, measure), measure)}
              </span>
            )}
          </li>
        ))}
        {shown !== undefined && <li className="actor-chart__when">{clock(shown.createdAt)}</li>}
      </ul>
    </div>
  );
}

/** A call to the model: its response's ID and what it came to; opened, all it sent back. */
function RequestRow({ entry, measure }: { entry: ConversationEntry; measure: Measure }) {
  const [open, setOpen] = useState(false);
  const message = entry.message;
  const id = message.id ?? `#${String(entry.seq)}`;
  return (
    <li className="actor-task" data-open={open || undefined}>
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
        <span className="actor-task__when">{wholeOf(entry.completion?.usage, measure)}</span>
      </div>
      {open && message.role === 'assistant' && (
        <div className="actor-task__detail">
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
