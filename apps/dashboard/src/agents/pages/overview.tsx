// An agent at a glance: over a range of days, what its model calls came to, each day split by
// the actors that made them, and where the tokens went. The pieces are the Usage page's,
// narrowed to the agent.

import { useParams } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

import { rangeStart, TIME_ZONE } from '../../llm/format.ts';
import { useUsage } from '../../llm/queries.ts';
import { RANGES, Tiles, TimeChart, Tokens, type Range } from '../../llm/usage.tsx';
import { LoadError, PageHeader } from '../../machines/ui.tsx';
import { Segmented } from '../../ui.tsx';
import { useActors, useAgent } from '../queries.ts';
import { actorName } from './agent.tsx';
import '../../llm/llm.css';
import '../agents.css';

/** The four actors that cost most in the range in the theme's hues, the rest in gray. */
const HUES = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)'];
const actorHue = (_key: string, rank: number): string => HUES[rank] ?? 'var(--series-2)';

export function OverviewPage() {
  const { agent } = useParams({ strict: false }) as { agent: string };
  const detail = useAgent(agent);
  const [range, setRange] = useState<Range>('30');
  // Read once for the range, so that a refetch does not move it under the page.
  const from = useMemo(() => (range === 'all' ? undefined : rangeStart(Number(range))), [range]);
  const scope = { agent: agent as never, ...(from === undefined ? {} : { from }) };
  // Each day split by actor: who spent it.
  const daily = useUsage({ ...scope, by: 'day', split: 'actor', tz: TIME_ZONE });
  const total = daily.data?.total;
  const info = detail.data;
  // Its actors' names, where they have them: the newest page of them.
  const listed = useActors(agent, undefined);
  const names = new Map<string, string>(
    (listed.data?.items ?? []).flatMap((one) =>
      one.name === null ? [] : [[one.id as string, one.name] as const],
    ),
  );

  return (
    <div className="list-page llm-page usage-page agent-overview">
      <PageHeader title="Overview">
        <Segmented label="Range" value={range} options={RANGES} onChange={setRange} />
      </PageHeader>
      {daily.error !== null && (
        <LoadError
          things="usage"
          error={daily.error}
          retrying={daily.isFetching}
          onRetry={() => void daily.refetch()}
        />
      )}
      <Tiles total={total} />
      <TimeChart
        groups={daily.data?.groups}
        from={from ?? daily.data?.total.first ?? info?.createdAt ?? Date.now()}
        to={Date.now()}
        series={actorHue}
        name={(key) => actorName({ id: key, name: names.get(key) ?? null }, 24)}
      />
      <Tokens total={total} />
    </div>
  );
}
