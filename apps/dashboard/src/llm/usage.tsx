// `/usage`: what model calls cost, over a range of days of the viewer's own time zone. The range,
// beside the heading, scopes everything below it: the totals beside those of the range before,
// what was spent each day by provider, each provider's and model's part, the actors that cost
// most with their subagents, where the tokens went, and what each agent spent.

import type { UsageTotals } from '@acentric/protocol';
import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

import { actorName } from '../agents/pages/agent.tsx';
import { useAgentNames } from '../machines/agents.tsx';
import { LoadError, PageHeader } from '../machines/ui.tsx';
import { Segmented } from '../ui.tsx';
import type { Group } from './api.ts';
import {
  cacheShare,
  change,
  compact,
  dayLabel,
  daysBetween,
  dollars,
  duration,
  percent,
  PROVIDER_NAMES,
  providerName,
  rangeStart,
  ticks,
  TIME_ZONE,
} from './format.ts';
import { useUsage } from './queries.ts';

import './llm.css';

type Range = '7' | '30' | '90' | 'all';

const RANGES: ReadonlyArray<readonly [Range, string]> = [
  ['7', '7 days'],
  ['30', '30 days'],
  ['90', '90 days'],
  ['all', 'All time'],
];

type Measure = 'cost' | 'tokens' | 'calls';

const MEASURES: ReadonlyArray<readonly [Measure, string]> = [
  ['cost', 'Spend'],
  ['tokens', 'Tokens'],
  ['calls', 'Calls'],
];

/** What a group comes to, in what is measured. */
const valueOf = (totals: UsageTotals, measure: Measure): number =>
  measure === 'cost'
    ? totals.cost
    : measure === 'tokens'
      ? totals.totalInput + totals.output
      : totals.calls;

/** What a call cost on average: to four places under a dollar, where cents say too little. */
const perCall = (value: number): string =>
  value === 0 ? '$0.00' : value < 1 ? `$${value.toFixed(4)}` : dollars(value);

/** A value as what is measured is written. */
const written = (value: number, measure: Measure): string =>
  measure === 'cost' ? dollars(value) : compact(value);

/**
 * The series a provider is drawn in: the same one whatever the range, in the order the providers
 * are known, so that a provider keeps its shade. Those past the fifth share the last.
 */
const KNOWN = Object.keys(PROVIDER_NAMES);
const seriesOf = (provider: string): string => {
  const at = KNOWN.indexOf(provider);
  return `var(--series-${String(Math.min(at === -1 ? KNOWN.length : at, 4))})`;
};

export function UsagePage() {
  const [range, setRange] = useState<Range>('30');
  // Read once for the range, so that a refetch does not move it under the page.
  const { from, before } = useMemo(() => {
    if (range === 'all') return { from: undefined, before: undefined };
    const days = Number(range);
    const start = rangeStart(days);
    return { from: start, before: rangeStart(days, start - 1) };
  }, [range]);
  const scope = from === undefined ? {} : { from };
  const daily = useUsage({ ...scope, by: 'day', split: 'provider', tz: TIME_ZONE });
  const previous = useUsage(
    before === undefined || from === undefined ? {} : { from: before, to: from },
    before !== undefined,
  );
  const providers = useUsage({ ...scope, by: 'provider' });
  const models = useUsage({ ...scope, by: 'model' });
  const roots = useUsage({ ...scope, by: 'root' });
  const agents = useUsage({ ...scope, by: 'agent' });
  const names = useAgentNames();

  const total = daily.data?.total;
  const reads = [daily, providers, models, roots, agents];
  const error = reads.find((read) => read.error !== null)?.error ?? null;
  const span = range === 'all' ? null : `${range} days`;
  return (
    <div className="list-page llm-page usage-page">
      <PageHeader title="LLM Usage" spaced>
        <Segmented label="Range" value={range} options={RANGES} onChange={setRange} />
      </PageHeader>
      {error !== null && (
        <LoadError
          things="usage"
          error={error}
          retrying={reads.some((read) => read.isFetching)}
          onRetry={() => {
            for (const read of reads) void read.refetch();
          }}
        />
      )}
      <Tiles
        total={total}
        before={range === 'all' ? undefined : previous.data?.total}
        span={span}
      />
      <TimeChart
        groups={daily.data?.groups}
        from={from ?? daily.data?.total.first ?? Date.now()}
        to={Date.now()}
      />
      <div className="usage-cards rise">
        <Card title="By provider">
          <Bars
            label="Spend by provider"
            groups={providers.data?.groups}
            total={providers.data?.total}
            name={(key) => providerName(key)}
            swatch={seriesOf}
            note={(group) => `${percent(cacheShare(group))} from cache`}
          />
        </Card>
        <Card title="By model">
          <Bars
            label="Spend by model"
            groups={models.data?.groups}
            total={models.data?.total}
            name={(key) => <span className="mono">{key}</span>}
            most={6}
            note={(group) => `${compact(group.calls)} calls`}
          />
        </Card>
        <Card title="Top actors" hint="With their subagents">
          <Bars
            label="Spend by actor"
            groups={roots.data?.groups}
            total={roots.data?.total}
            name={(key) => (
              <Link
                to={'/actors/$actor' as never}
                params={{ actor: key } as never}
                className="title-link mono"
                title={key}
              >
                {actorName({ id: key, name: null }, 20)}
              </Link>
            )}
            most={5}
            rest={false}
            note={(group) => `${compact(group.calls)} calls`}
          />
        </Card>
      </div>
      <Tokens total={total} />
      <section className="usage-panel rise" aria-labelledby="usage-agents">
        <div className="usage-panel__head">
          <h2 className="panel__title" id="usage-agents">
            By agent
          </h2>
        </div>
        <Agents
          groups={agents.data?.groups}
          total={agents.data?.total}
          names={names}
          loading={agents.isPending}
        />
      </section>
    </div>
  );
}

/** The numbers of the range, each beside what it was in the range before, when there was one. */
function Tiles({
  total,
  before,
  span,
}: {
  total: UsageTotals | undefined;
  before: UsageTotals | undefined;
  span: string | null;
}) {
  const against = (now: number, then: number | undefined) => {
    const moved = then === undefined ? undefined : change(now, then);
    return moved === undefined || span === null ? null : `${moved} on the ${span} before`;
  };
  const tokens = (of: UsageTotals) => of.totalInput + of.output;
  const share = (of: UsageTotals | undefined) => (of === undefined ? undefined : cacheShare(of));
  const points = (() => {
    const now = share(total);
    const then = share(before);
    if (now === undefined || then === undefined || span === null) return null;
    const moved = Math.round((now - then) * 100);
    return `${moved > 0 ? '+' : moved < 0 ? '−' : ''}${String(Math.abs(moved))} pts on the ${span} before`;
  })();
  const tiles: { label: string; value: string; notes: (string | null)[] }[] =
    total === undefined
      ? ['Spend', 'Model calls', 'Tokens', 'Cache hits', 'Typical call'].map((label) => ({
          label,
          value: '—',
          notes: [],
        }))
      : [
          {
            label: 'Spend',
            value: dollars(total.cost),
            notes: [
              against(total.cost, before?.cost),
              total.estimatedCost > 0
                ? total.estimatedCost === total.cost
                  ? 'estimated from prices'
                  : `${dollars(total.estimatedCost)} estimated`
                : null,
              total.unpriced > 0 ? `${compact(total.unpriced)} calls of unknown price` : null,
            ],
          },
          {
            label: 'Model calls',
            value: compact(total.calls),
            notes: [
              against(total.calls, before?.calls),
              total.failed > 0
                ? `${compact(total.failed)} failed (${percent(total.failed / total.calls)})`
                : null,
            ],
          },
          {
            label: 'Tokens',
            value: compact(tokens(total)),
            notes: [
              against(tokens(total), before === undefined ? undefined : tokens(before)),
              `${compact(total.totalInput)} in · ${compact(total.output)} out`,
            ],
          },
          {
            label: 'Cache hits',
            value: percent(cacheShare(total)),
            notes: [points],
          },
          {
            label: 'Typical call',
            value: duration(total.medianMs),
            notes: [total.p95Ms === null ? null : `${duration(total.p95Ms)} for the slowest 5%`],
          },
        ];
  return (
    <div className="usage-tiles rise">
      {tiles.map((tile) => (
        <div key={tile.label} className="usage-tile">
          <span className="usage-tile__label">{tile.label}</span>
          <span className="usage-tile__value">{tile.value}</span>
          {tile.notes
            .filter((note): note is string => note !== null)
            .map((note) => (
              <span key={note} className="usage-tile__note">
                {note}
              </span>
            ))}
        </div>
      ))}
    </div>
  );
}

type Day = { readonly day: string; readonly parts: readonly Group[]; readonly whole: Group | null };

/**
 * Each day of the range as a column, by provider, in what is measured: a tooltip on each, a
 * legend of the providers when there are several, and a table to read instead.
 */
function TimeChart({
  groups,
  from,
  to,
}: {
  groups: readonly Group[] | undefined;
  from: number;
  to: number;
}) {
  const [measure, setMeasure] = useState<Measure>('cost');
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const byDay = new Map((groups ?? []).map((group) => [group.key, group]));
  const days: Day[] = daysBetween(from, Math.max(from, to)).map((day) => {
    const whole = byDay.get(day) ?? null;
    return { day, whole, parts: whole?.parts ?? [] };
  });
  // The providers of the range, those that come to most first, each in its own series.
  const sums = new Map<string, number>();
  for (const day of days) {
    for (const part of day.parts)
      sums.set(part.key, (sums.get(part.key) ?? 0) + valueOf(part, measure));
  }
  const providers = [...sums].toSorted((a, b) => b[1] - a[1]).map(([key]) => key);
  const max = Math.max(
    ...days.map((day) => (day.whole === null ? 0 : valueOf(day.whole, measure))),
    0,
  );
  const axis = ticks(max);
  const top = axis.at(-1) ?? 0;
  const labelled = new Set([0, days.length - 1, Math.floor((days.length - 1) / 2)]);
  const shown = hover === null ? undefined : days[hover];
  const measured = MEASURES.find(([value]) => value === measure)?.[1] ?? '';
  const axisText = (value: number) =>
    measure === 'cost' ? (top === 0 ? '$0' : dollars(value).replace(/\.00$/, '')) : compact(value);

  return (
    <section className="usage-panel rise" aria-labelledby="usage-daily">
      <div className="usage-panel__head">
        <h2 className="panel__title" id="usage-daily">
          {measured} by day
        </h2>
        <Segmented label="Measure" value={measure} options={MEASURES} onChange={setMeasure} />
      </div>
      {groups === undefined ? (
        <div className="usage-chart usage-chart--loading" aria-busy="true" />
      ) : asTable ? (
        <div className="ac-table-wrap">
          <table className="ac-table usage-table" aria-label={`${measured} by day`}>
            <thead>
              <tr>
                <th scope="col">Day</th>
                {providers.map((provider) => (
                  <th key={provider} scope="col" className="ac-table__num">
                    {providerName(provider)}
                  </th>
                ))}
                <th scope="col" className="ac-table__num">
                  All
                </th>
              </tr>
            </thead>
            <tbody>
              {days.toReversed().map((day) => (
                <tr key={day.day}>
                  <td>{dayLabel(day.day)}</td>
                  {providers.map((provider) => {
                    const part = day.parts.find((each) => each.key === provider);
                    return (
                      <td key={provider} className="ac-table__num">
                        {written(part === undefined ? 0 : valueOf(part, measure), measure)}
                      </td>
                    );
                  })}
                  <td className="ac-table__num">
                    {written(day.whole === null ? 0 : valueOf(day.whole, measure), measure)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="usage-chart" onPointerLeave={() => setHover(null)}>
          <div className="usage-chart__axis" aria-hidden="true">
            {axis.toReversed().map((value) => (
              <span key={value}>{axisText(value)}</span>
            ))}
          </div>
          <div className="usage-chart__plot">
            <div className="usage-chart__grid" aria-hidden="true">
              {axis.map((value) => (
                <span key={value} style={{ bottom: `${top === 0 ? 0 : (value / top) * 100}%` }} />
              ))}
            </div>
            <div className="usage-chart__columns" role="list" aria-label={`${measured} by day`}>
              {days.map((day, index) => {
                const all = day.whole === null ? 0 : valueOf(day.whole, measure);
                return (
                  <div
                    key={day.day}
                    role="listitem"
                    tabIndex={0}
                    className="usage-chart__slot"
                    data-active={hover === index || undefined}
                    aria-label={`${dayLabel(day.day)}: ${written(all, measure)}`}
                    onPointerEnter={() => setHover(index)}
                    onFocus={() => setHover(index)}
                    onBlur={() => setHover(null)}
                  >
                    <span
                      className="usage-chart__stack"
                      style={{
                        height: top === 0 || all === 0 ? 0 : `max(2px, ${(all / top) * 100}%)`,
                      }}
                    >
                      {providers.toReversed().map((provider) => {
                        const part = day.parts.find((each) => each.key === provider);
                        const value = part === undefined ? 0 : valueOf(part, measure);
                        return value === 0 ? null : (
                          <span
                            key={provider}
                            className="usage-chart__part"
                            style={{ flexGrow: value, background: seriesOf(provider) }}
                          />
                        );
                      })}
                    </span>
                    {labelled.has(index) && (
                      <span className="usage-chart__label">{dayLabel(day.day)}</span>
                    )}
                  </div>
                );
              })}
            </div>
            {shown !== undefined && hover !== null && (
              <div
                className="usage-tooltip"
                role="status"
                style={{ left: `${((hover + 0.5) / days.length) * 100}%` }}
              >
                <strong>
                  {written(shown.whole === null ? 0 : valueOf(shown.whole, measure), measure)}
                </strong>
                <span>{dayLabel(shown.day)}</span>
                {shown.parts.length > 1 &&
                  providers
                    .filter((provider) => shown.parts.some((part) => part.key === provider))
                    .map((provider) => {
                      const part = shown.parts.find((each) => each.key === provider);
                      return (
                        <span key={provider} className="usage-tooltip__row">
                          <span
                            className="usage-swatch"
                            style={{ background: seriesOf(provider) }}
                            aria-hidden="true"
                          />
                          {providerName(provider)}
                          <span className="usage-tooltip__value">
                            {written(part === undefined ? 0 : valueOf(part, measure), measure)}
                          </span>
                        </span>
                      );
                    })}
                {shown.whole !== null && shown.whole.failed > 0 && (
                  <span>{compact(shown.whole.failed)} failed</span>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      <div className="usage-panel__foot">
        {providers.length > 1 && !asTable && (
          <ul className="usage-legend" aria-label="Providers">
            {providers.map((provider) => (
              <li key={provider}>
                <span
                  className="usage-swatch"
                  style={{ background: seriesOf(provider) }}
                  aria-hidden="true"
                />
                {providerName(provider)}
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          className="chip chip--toggle"
          aria-pressed={asTable}
          onClick={() => setAsTable((was) => !was)}
        >
          Table
        </button>
      </div>
    </section>
  );
}

function Card({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="usage-card" aria-label={title}>
      <div className="usage-panel__head">
        <h2 className="panel__title">{title}</h2>
        {hint !== undefined && <span className="note">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

/**
 * What each group spent, the most first, as a bar of its share of the whole: the first `most`,
 * and the rest together as one when `rest` is not turned off.
 */
function Bars({
  label,
  groups,
  total,
  name,
  note,
  swatch,
  most = 5,
  rest = true,
}: {
  label: string;
  groups: readonly Group[] | undefined;
  total: UsageTotals | undefined;
  name: (key: string) => ReactNode;
  note: (group: Group) => string;
  swatch?: (key: string) => string;
  most?: number;
  rest?: boolean;
}) {
  if (groups === undefined) {
    return (
      <div className="skeleton">
        <span className="skeleton__line" />
        <span className="skeleton__line" />
      </div>
    );
  }
  if (groups.length === 0) return <p className="table-empty">No model calls in this range</p>;
  const whole = total?.cost ?? 0;
  const shown = groups.slice(0, most);
  const others = groups.slice(most);
  const otherCost = others.reduce((sum, group) => sum + group.cost, 0);
  const rows: { key: string; title: ReactNode; cost: number; note: string; fill?: string }[] = [
    ...shown.map((group) => ({
      key: group.key,
      title: name(group.key),
      cost: group.cost,
      note: note(group),
      ...(swatch === undefined ? {} : { fill: swatch(group.key) }),
    })),
    ...(rest && others.length > 0
      ? [
          {
            key: '',
            title: `${String(others.length)} more`,
            cost: otherCost,
            note: `${compact(others.reduce((sum, group) => sum + group.calls, 0))} calls`,
          },
        ]
      : []),
  ];
  return (
    <ul className="usage-bars" aria-label={label}>
      {rows.map((row) => {
        const share = whole === 0 ? 0 : row.cost / whole;
        return (
          <li key={row.key} className="usage-bars__row">
            <span className="usage-bars__name">
              {row.fill !== undefined && (
                <span
                  className="usage-swatch"
                  style={{ background: row.fill }}
                  aria-hidden="true"
                />
              )}
              {row.title}
            </span>
            <span className="usage-bars__value">{dollars(row.cost)}</span>
            <span className="usage-share usage-bars__share" title={percent(share)}>
              <span
                className="usage-share__fill"
                style={
                  {
                    width: `${share * 100}%`,
                    ...(row.fill === undefined ? {} : { background: row.fill }),
                  } as CSSProperties
                }
              />
            </span>
            <span className="usage-bars__note">
              {percent(share)} · {row.note}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Where the tokens went: input from no cache, read from one and written to one, and output. */
function Tokens({ total }: { total: UsageTotals | undefined }) {
  if (total === undefined) return null;
  const parts = [
    { label: 'Input', value: total.input, series: 'var(--series-0)' },
    { label: 'Read from cache', value: total.cacheRead, series: 'var(--series-1)' },
    { label: 'Written to cache', value: total.cacheWrite, series: 'var(--series-2)' },
    { label: 'Output', value: total.output, series: 'var(--series-3)' },
  ];
  const whole = parts.reduce((sum, part) => sum + part.value, 0);
  return (
    <section className="usage-panel rise" aria-labelledby="usage-tokens">
      <div className="usage-panel__head">
        <h2 className="panel__title" id="usage-tokens">
          Where the tokens went
        </h2>
        {total.reasoning > 0 && (
          <span className="note">{compact(total.reasoning)} of the output was reasoning</span>
        )}
      </div>
      {whole === 0 ? (
        <p className="table-empty">No model calls in this range</p>
      ) : (
        <>
          <div className="usage-split" role="img" aria-label="Tokens by kind">
            {parts.map((part) =>
              part.value === 0 ? null : (
                <span
                  key={part.label}
                  className="usage-split__part"
                  style={{ flexGrow: part.value, background: part.series }}
                  title={`${part.label}: ${compact(part.value)}`}
                />
              ),
            )}
          </div>
          <ul className="usage-legend usage-legend--values" aria-label="Tokens by kind">
            {parts.map((part) => (
              <li key={part.label}>
                <span
                  className="usage-swatch"
                  style={{ background: part.series }}
                  aria-hidden="true"
                />
                {part.label}
                <span className="usage-legend__value">
                  {compact(part.value)} · {percent(part.value / whole)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** What each agent spent, the most first, with how its calls went and its share of the whole. */
function Agents({
  groups,
  total,
  names,
  loading,
}: {
  groups: readonly Group[] | undefined;
  total: UsageTotals | undefined;
  names: ReadonlyMap<string, string>;
  loading: boolean;
}) {
  if (loading && groups === undefined) {
    return (
      <div className="skeleton">
        <span className="skeleton__line" />
        <span className="skeleton__line" />
      </div>
    );
  }
  if (groups === undefined || groups.length === 0) {
    return <p className="table-empty">No model calls in this range</p>;
  }
  const whole = total?.cost ?? 0;
  return (
    <div className="ac-table-wrap">
      <table className="ac-table usage-table" aria-label="Spend by agent">
        <thead>
          <tr>
            <th scope="col">Agent</th>
            <th scope="col" className="ac-table__num">
              Calls
            </th>
            <th scope="col" className="ac-table__num">
              Failed
            </th>
            <th scope="col" className="ac-table__num">
              Tokens
            </th>
            <th scope="col" className="ac-table__num">
              From cache
            </th>
            <th scope="col" className="ac-table__num">
              Typical call
            </th>
            <th scope="col" className="ac-table__num">
              Per call
            </th>
            <th scope="col" className="ac-table__num">
              Spend
            </th>
            <th scope="col">Share</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => {
            const share = whole === 0 ? 0 : group.cost / whole;
            return (
              <tr key={group.key}>
                <td>
                  <Link
                    to={'/agents/$agent' as never}
                    params={{ agent: group.key } as never}
                    className="title-link"
                    title={group.key}
                  >
                    {names.get(group.key) ?? group.key}
                  </Link>
                </td>
                <td className="ac-table__num">{compact(group.calls)}</td>
                <td className="ac-table__num">
                  {group.failed === 0 ? '—' : compact(group.failed)}
                </td>
                <td className="ac-table__num">{compact(group.totalInput + group.output)}</td>
                <td className="ac-table__num">{percent(cacheShare(group))}</td>
                <td className="ac-table__num">{duration(group.medianMs)}</td>
                <td className="ac-table__num">
                  {group.calls === 0 ? '—' : perCall(group.cost / group.calls)}
                </td>
                <td className="ac-table__num">
                  {dollars(group.cost)}
                  {group.unpriced > 0 && (
                    <span className="note" title="Calls whose price is not known">
                      {' '}
                      +?
                    </span>
                  )}
                </td>
                <td>
                  <span className="usage-share" title={percent(share)}>
                    <span className="usage-share__fill" style={{ width: `${share * 100}%` }} />
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
