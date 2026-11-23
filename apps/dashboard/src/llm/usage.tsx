// `/usage`: what model calls cost, over a range of days. The filters in one row scope everything
// below them: the totals, the spend of each day, how much of each provider's input was read from
// its prompt cache, and what each agent, actor, account or model spent.

import type { UsageGroup, UsageTotals } from '@acentric/protocol';
import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

import { useAgentNames } from '../machines/agents.tsx';
import { LoadError, PageHeader } from '../machines/ui.tsx';
import { may, useMe } from '../me.ts';
import { Dropdown, Segmented } from '../ui.tsx';
import type { Group } from './api.ts';
import {
  cacheShare,
  compact,
  dayLabel,
  daysBetween,
  dollars,
  percent,
  providerName,
  rangeStart,
  ticks,
} from './format.ts';
import { useAccounts, useUsage } from './queries.ts';

import './llm.css';

type Range = '7' | '30' | '90' | 'all';

const RANGES: ReadonlyArray<readonly [Range, string]> = [
  ['7', '7 days'],
  ['30', '30 days'],
  ['90', '90 days'],
  ['all', 'All time'],
];

type By = Exclude<UsageGroup, 'day'>;

const GROUPS: ReadonlyArray<{ value: By; label: string }> = [
  { value: 'agent', label: 'By agent' },
  { value: 'root', label: 'By actor, with its subagents' },
  { value: 'actor', label: 'By actor' },
  { value: 'account', label: 'By account' },
  { value: 'model', label: 'By model' },
  { value: 'provider', label: 'By provider' },
];

export function UsagePage() {
  const [range, setRange] = useState<Range>('30');
  const [by, setBy] = useState<By>('agent');
  // Read once for the page, so that a refetch does not move the range under it.
  const from = useMemo(() => (range === 'all' ? undefined : rangeStart(Number(range))), [range]);
  const scope = from === undefined ? {} : { from };
  const daily = useUsage({ ...scope, by: 'day' });
  const groups = useUsage({ ...scope, by });
  const byProvider = useUsage({ ...scope, by: 'provider' });
  const me = useMe();
  // Accounts are named for a person who may see them; for any other, their IDs.
  const accounts = useAccounts(me.data !== undefined && may(me.data, 'accounts:manage'));
  const agents = useAgentNames();
  const names = new Map([
    ...(accounts.data ?? []).map((account) => [account.id, account.name] as const),
    ...agents,
  ]);

  const total = daily.data?.total;
  const error = daily.error ?? groups.error ?? byProvider.error;
  return (
    <div className="list-page llm-page usage-page">
      <PageHeader title="Usage" spaced />
      <div className="usage-filters rise">
        <Segmented label="Range" value={range} options={RANGES} onChange={setRange} />
        <Dropdown label="Group" value={by} options={GROUPS} onChange={setBy} />
      </div>
      {error !== null && (
        <LoadError
          things="usage"
          error={error}
          retrying={daily.isFetching || groups.isFetching}
          onRetry={() => {
            void daily.refetch();
            void groups.refetch();
            void byProvider.refetch();
          }}
        />
      )}
      <Tiles total={total} />
      <section className="usage-panel rise" aria-labelledby="usage-daily">
        <div className="usage-panel__head">
          <h2 className="panel__title" id="usage-daily">
            Spend by day
          </h2>
          <span className="note">Days in UTC</span>
        </div>
        {daily.data === undefined ? (
          <div className="usage-chart usage-chart--loading" aria-busy="true" />
        ) : (
          <DailyChart
            groups={daily.data.groups ?? []}
            from={from ?? daily.data.total.first ?? Date.now()}
            to={Date.now()}
          />
        )}
      </section>
      <section className="usage-panel rise" aria-labelledby="usage-cache">
        <div className="usage-panel__head">
          <h2 className="panel__title" id="usage-cache">
            Prompt cache by provider
          </h2>
          <span className="note">Of the input tokens, those read from cache</span>
        </div>
        <CacheByProvider groups={byProvider.data?.groups} loading={byProvider.isPending} />
      </section>
      <section className="usage-panel rise" aria-labelledby="usage-groups">
        <div className="usage-panel__head">
          <h2 className="panel__title" id="usage-groups">
            {GROUPS.find((group) => group.value === by)?.label}
          </h2>
        </div>
        <Breakdown
          by={by}
          groups={groups.data?.groups}
          total={groups.data?.total}
          names={names}
          loading={groups.isPending}
        />
      </section>
    </div>
  );
}

/** The numbers of the range. */
function Tiles({ total }: { total: UsageTotals | undefined }) {
  const tiles: { label: string; value: string; note: string | null }[] = [
    {
      label: 'Spend',
      value: total === undefined ? '—' : dollars(total.cost),
      note:
        total === undefined
          ? null
          : [
              total.estimatedCost > 0
                ? total.estimatedCost === total.cost
                  ? 'estimated from prices'
                  : `${dollars(total.estimatedCost)} estimated`
                : null,
              total.unpriced > 0 ? `${compact(total.unpriced)} calls of unknown price` : null,
            ]
              .filter(Boolean)
              .join(' · ') || null,
    },
    {
      label: 'Model calls',
      value: total === undefined ? '—' : compact(total.calls),
      note:
        total === undefined
          ? null
          : [
              total.failed > 0 ? `${compact(total.failed)} failed` : null,
              total.webSearches > 0 ? `${compact(total.webSearches)} web searches` : null,
            ]
              .filter(Boolean)
              .join(' · ') || null,
    },
    {
      label: 'Input tokens',
      value: total === undefined ? '—' : compact(total.totalInput),
      note:
        total === undefined || total.cacheWrite === 0
          ? null
          : `${compact(total.cacheWrite)} written to cache`,
    },
    {
      label: 'Cache hits',
      value: total === undefined ? '—' : percent(cacheShare(total)),
      note:
        total === undefined || total.totalInput === 0
          ? null
          : `${compact(total.cacheRead)} of ${compact(total.totalInput)} input tokens`,
    },
    {
      label: 'Output tokens',
      value: total === undefined ? '—' : compact(total.output),
      note:
        total === undefined || total.reasoning === 0
          ? null
          : `${compact(total.reasoning)} reasoning`,
    },
  ];
  return (
    <div className="usage-tiles rise">
      {tiles.map((tile) => (
        <div key={tile.label} className="usage-tile">
          <span className="usage-tile__label">{tile.label}</span>
          <span className="usage-tile__value">{tile.value}</span>
          {tile.note !== null && <span className="usage-tile__note">{tile.note}</span>}
        </div>
      ))}
    </div>
  );
}

type Day = {
  readonly day: string;
  readonly cost: number;
  readonly calls: number;
  readonly failed: number;
  readonly tokens: number;
};

/** Spend of each day of the range, as columns, with a tooltip on each and a table to read. */
function DailyChart({ groups, from, to }: { groups: readonly Group[]; from: number; to: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const byDay = new Map(groups.map((group) => [group.key, group]));
  const days: Day[] = daysBetween(from, to).map((day) => {
    const group = byDay.get(day);
    return {
      day,
      cost: group?.cost ?? 0,
      calls: group?.calls ?? 0,
      failed: group?.failed ?? 0,
      tokens: (group?.totalInput ?? 0) + (group?.output ?? 0),
    };
  });
  const max = Math.max(...days.map((day) => day.cost), 0);
  const axis = ticks(max);
  const top = axis.at(-1) ?? 0;
  // A label at the start, the end, and between, so that they never crowd.
  const labelled = new Set([0, days.length - 1, Math.floor((days.length - 1) / 2)]);
  const shown = hover === null ? undefined : days[hover];

  return (
    <>
      {asTable ? (
        <div className="ac-table-wrap">
          <table className="ac-table" aria-label="Spend by day">
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col" className="ac-table__num">
                  Spend
                </th>
                <th scope="col" className="ac-table__num">
                  Calls
                </th>
                <th scope="col" className="ac-table__num">
                  Tokens
                </th>
              </tr>
            </thead>
            <tbody>
              {days.toReversed().map((day) => (
                <tr key={day.day}>
                  <td>{day.day}</td>
                  <td className="ac-table__num">{dollars(day.cost)}</td>
                  <td className="ac-table__num">{compact(day.calls)}</td>
                  <td className="ac-table__num">{compact(day.tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="usage-chart" onPointerLeave={() => setHover(null)}>
          <div className="usage-chart__axis" aria-hidden="true">
            {axis.toReversed().map((value) => (
              <span key={value}>{top === 0 ? '$0' : dollars(value).replace(/\.00$/, '')}</span>
            ))}
          </div>
          <div className="usage-chart__plot">
            <div className="usage-chart__grid" aria-hidden="true">
              {axis.map((value) => (
                <span key={value} style={{ bottom: `${top === 0 ? 0 : (value / top) * 100}%` }} />
              ))}
            </div>
            <div className="usage-chart__columns" role="list" aria-label="Spend by day">
              {days.map((day, index) => (
                <div
                  key={day.day}
                  role="listitem"
                  tabIndex={0}
                  className="usage-chart__slot"
                  data-active={hover === index || undefined}
                  aria-label={`${dayLabel(day.day)}: ${dollars(day.cost)}, ${String(day.calls)} calls`}
                  onPointerEnter={() => setHover(index)}
                  onFocus={() => setHover(index)}
                  onBlur={() => setHover(null)}
                >
                  <span
                    className="usage-chart__bar"
                    style={{
                      height:
                        top === 0 || day.cost === 0 ? 0 : `max(2px, ${(day.cost / top) * 100}%)`,
                    }}
                  />
                  {labelled.has(index) && (
                    <span className="usage-chart__label">{dayLabel(day.day)}</span>
                  )}
                </div>
              ))}
            </div>
            {shown !== undefined && hover !== null && (
              <div
                className="usage-tooltip"
                role="status"
                style={{ left: `${((hover + 0.5) / days.length) * 100}%` }}
              >
                <strong>{dollars(shown.cost)}</strong>
                <span>{dayLabel(shown.day)}</span>
                <span>
                  {compact(shown.calls)} calls
                  {shown.failed > 0 ? ` · ${compact(shown.failed)} failed` : ''}
                </span>
                <span>{compact(shown.tokens)} tokens</span>
              </div>
            )}
          </div>
        </div>
      )}
      <div className="usage-panel__foot">
        <button
          type="button"
          className="chip chip--toggle"
          aria-pressed={asTable}
          onClick={() => setAsTable((was) => !was)}
        >
          Table
        </button>
      </div>
    </>
  );
}

/** Each provider's share of its input read from its prompt cache, the most input first. */
function CacheByProvider({
  groups,
  loading,
}: {
  groups: readonly Group[] | undefined;
  loading: boolean;
}) {
  if (loading && groups === undefined) {
    return (
      <div className="skeleton">
        <span className="skeleton__line" />
      </div>
    );
  }
  const rows = (groups ?? [])
    .filter((group) => group.totalInput > 0)
    .toSorted((a, b) => b.totalInput - a.totalInput);
  if (rows.length === 0) return <p className="table-empty">No model calls in this range</p>;
  return (
    <div className="ac-table-wrap">
      <table className="ac-table usage-table" aria-label="Prompt cache by provider">
        <thead>
          <tr>
            <th scope="col">Provider</th>
            <th scope="col" className="ac-table__num">
              Cache hits
            </th>
            <th scope="col">Of the input</th>
            <th scope="col" className="ac-table__num">
              Read from cache
            </th>
            <th scope="col" className="ac-table__num">
              Input
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((group) => {
            const share = cacheShare(group) ?? 0;
            return (
              <tr key={group.key}>
                <td>{providerName(group.key)}</td>
                <td className="ac-table__num">{percent(share)}</td>
                <td>
                  <span className="usage-share usage-share--wide" title={percent(share)}>
                    <span className="usage-share__fill" style={{ width: `${share * 100}%` }} />
                  </span>
                </td>
                <td className="ac-table__num">{compact(group.cacheRead)}</td>
                <td className="ac-table__num">{compact(group.totalInput)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** What each group spent, the most first, with its share of the whole. */
function Breakdown({
  by,
  groups,
  total,
  names,
  loading,
}: {
  by: By;
  groups: readonly Group[] | undefined;
  total: UsageTotals | undefined;
  /** The names of agents and accounts, by their IDs. */
  names: ReadonlyMap<string, string>;
  loading: boolean;
}) {
  const name = (key: string) => {
    if (by === 'agent') {
      return (
        <Link
          to={'/agents/$agent' as never}
          params={{ agent: key } as never}
          className="title-link"
          title={key}
        >
          {names.get(key) ?? key}
        </Link>
      );
    }
    if (by === 'actor' || by === 'root') {
      return (
        <Link
          to={'/actors/$actor' as never}
          params={{ actor: key } as never}
          className="title-link mono"
        >
          {key}
        </Link>
      );
    }
    if (by === 'account') return names.get(key) ?? <span className="mono">{key}</span>;
    if (by === 'provider') return providerName(key);
    return <span className="mono">{key}</span>;
  };
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
      <table className="ac-table usage-table" aria-label="Usage">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col" className="ac-table__num">
              Calls
            </th>
            <th scope="col" className="ac-table__num">
              Failed
            </th>
            <th scope="col" className="ac-table__num">
              Input
            </th>
            <th scope="col" className="ac-table__num">
              From cache
            </th>
            <th scope="col" className="ac-table__num">
              Output
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
                <td>{name(group.key)}</td>
                <td className="ac-table__num">{compact(group.calls)}</td>
                <td className="ac-table__num">
                  {group.failed === 0 ? '—' : compact(group.failed)}
                </td>
                <td className="ac-table__num">{compact(group.totalInput)}</td>
                <td className="ac-table__num">{percent(cacheShare(group))}</td>
                <td className="ac-table__num">{compact(group.output)}</td>
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
                  <span className="usage-share" title={`${(share * 100).toFixed(1)}%`}>
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
