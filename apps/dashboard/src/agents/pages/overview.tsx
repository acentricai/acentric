// An agent at a glance: what it is, and over a range of days what its model calls cost, by day,
// by model and by actor, where the tokens went, and how its actors stand. The pieces are the
// Usage page's, narrowed to the agent.

import type { ActorStatus } from '@acentric/protocol';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

import { version } from '../../format.ts';
import { compact, rangeStart, TIME_ZONE } from '../../llm/format.ts';
import { useUsage } from '../../llm/queries.ts';
import { Bars, Card, RANGES, Tiles, TimeChart, Tokens, type Range } from '../../llm/usage.tsx';
import { Ago, LoadError, PageHeader } from '../../machines/ui.tsx';
import { Segmented, Status } from '../../ui.tsx';
import { engine } from '../api.ts';
import { actorPath, agentPath } from '../links.tsx';
import { useActors, useAgent } from '../queries.ts';
import { actorName } from './agent.tsx';
import '../../llm/llm.css';
import '../agents.css';

const STANDING: readonly ActorStatus[] = ['working', 'idle', 'archived'];

/** How many of the agent's actors are of a status: as many as one page holds, at most. */
function useCount(agent: string, status: ActorStatus) {
  return useQuery({
    queryKey: ['actors', agent, 'count', status],
    queryFn: async () => {
      const page = await engine.actors({ agent, status }, undefined, 200);
      return { count: page.items.length, more: page.nextCursor !== null };
    },
    refetchInterval: 30_000,
  });
}

export function OverviewPage() {
  const { agent } = useParams({ strict: false }) as { agent: string };
  const detail = useAgent(agent);
  const [range, setRange] = useState<Range>('30');
  // Read once for the range, so that a refetch does not move it under the page.
  const from = useMemo(() => (range === 'all' ? undefined : rangeStart(Number(range))), [range]);
  const scope = { agent: agent as never, ...(from === undefined ? {} : { from }) };
  const daily = useUsage({ ...scope, by: 'day', split: 'provider', tz: TIME_ZONE });
  const models = useUsage({ ...scope, by: 'model' });
  const actors = useUsage({ ...scope, by: 'actor' });
  const reads = [daily, models, actors];
  const error = reads.find((read) => read.error !== null)?.error ?? null;
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
      <p className="agent-overview__facts rise">
        {info === undefined ? (
          <span>&nbsp;</span>
        ) : (
          <>
            <span className="mono">{version(info.activeDeployment.version)} active</span>
            {info.latestDeployment.version !== info.activeDeployment.version && (
              <span className="mono">{version(info.latestDeployment.version)} newest</span>
            )}
            <span className="mono">{info.provider}</span>
            <span>
              created <Ago at={info.createdAt} />
            </span>
          </>
        )}
      </p>
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
      <Tiles total={total} />
      <TimeChart
        groups={daily.data?.groups}
        from={from ?? daily.data?.total.first ?? info?.createdAt ?? Date.now()}
        to={Date.now()}
      />
      <div className="usage-cards rise">
        <Card title="By model">
          <Bars
            label="Spend by model"
            groups={models.data?.groups}
            total={models.data?.total}
            name={(key) => <span className="mono">{key}</span>}
            most={5}
            note={(group) => `${compact(group.calls)} calls`}
          />
        </Card>
        <Card title="Top actors">
          <Bars
            label="Spend by actor"
            groups={actors.data?.groups}
            total={actors.data?.total}
            name={(key) => (
              <Link to={actorPath(key, agent)} className="title-link mono" title={key}>
                {actorName({ id: key, name: names.get(key) ?? null }, 20)}
              </Link>
            )}
            most={5}
            rest={false}
          />
        </Card>
        <Card title="Actors">
          <Standing agent={agent} />
        </Card>
      </div>
      <Tokens total={total} />
    </div>
  );
}

/** How many of its actors work now, wait, and are archived: each a way into its Actors. */
function Standing({ agent }: { agent: string }) {
  const working = useCount(agent, 'working');
  const idle = useCount(agent, 'idle');
  const archived = useCount(agent, 'archived');
  const counts = { working, idle, archived };
  return (
    <ul className="agent-standing" aria-label="Actors by status">
      {STANDING.map((status) => {
        const read = counts[status as keyof typeof counts];
        return (
          <li key={status} className="agent-standing__row">
            <Status word={status} />
            <span className="agent-standing__count">
              {read.data === undefined
                ? '—'
                : `${String(read.data.count)}${read.data.more ? '+' : ''}`}
            </span>
          </li>
        );
      })}
      <li className="agent-standing__all">
        <Link to={agentPath(agent, 'actors')}>All actors</Link>
      </li>
    </ul>
  );
}
