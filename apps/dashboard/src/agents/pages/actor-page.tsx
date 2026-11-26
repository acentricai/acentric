// An actor's page: its conversation to the left, and beside it, to the right, what it is and
// what it cost. Being built again: the left is empty for now.

import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { fullTime, version } from '../../format.ts';
import { dollars } from '../../llm/format.ts';
import { useUsage } from '../../llm/queries.ts';
import { LoadError, NOT_FOUND } from '../../machines/ui.tsx';
import { may, useMe } from '../../me.ts';
import { Status } from '../../ui.tsx';
import { engine, isApiError } from '../api.ts';
import { useActor } from '../queries.ts';
import '../agents.css';

/** A line of the sidebar: what it is, and its value beside it. */
function Fact({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="actor-fact">
      <dt>{name}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function ActorPage() {
  const { actor: id } = useParams({ strict: false }) as { actor: string };
  const actor = useActor(id);
  const me = useMe();
  // An account by its name, for one who may list them; by its ID, for anyone else.
  const accounts = useQuery({
    queryKey: ['accounts', 'list'],
    queryFn: () => engine.accounts(),
    enabled: me.data !== undefined && may(me.data, 'accounts:manage'),
  });
  // What it and the actors under it spent, by actor; and what it spent itself, by kind of call.
  const tree = useUsage({ root: id as never, by: 'actor' });
  const own = useUsage({ actor: id as never, by: 'kind' });

  if (isApiError(actor.error, 404)) {
    return <p className="table-empty">{NOT_FOUND}</p>;
  }
  const info = actor.data;
  const account =
    info?.account == null
      ? null
      : (accounts.data?.items.find((one) => one.id === info.account)?.name ?? info.account);
  const total = tree.data?.total.cost;
  const itself = own.data?.total.cost;
  const ofKind = (kind: string) => own.data?.groups?.find((group) => group.key === kind)?.cost;
  const below = total === undefined || itself === undefined ? undefined : total - itself;

  return (
    <div className="actor-page">
      <div className="actor-page__main" />
      <aside className="actor-side" aria-label="About the actor">
        {actor.isError ? (
          <LoadError
            things="the actor"
            error={actor.error}
            compact
            onRetry={() => void actor.refetch()}
          />
        ) : info === undefined ? (
          <div className="skeleton" role="status" aria-label="Loading the actor">
            <span className="skeleton__line" />
            <span className="skeleton__line" />
            <span className="skeleton__line" />
          </div>
        ) : (
          <>
            <section className="actor-side__group" aria-labelledby="actor-details">
              <h2 className="actor-side__title" id="actor-details">
                Details
              </h2>
              <dl className="actor-facts">
                <Fact name="Status">
                  <Status word={info.status} />
                </Fact>
                <Fact name="Model">
                  <span className="mono">{info.modelId}</span>
                </Fact>
                <Fact name="Reasoning">{info.reasoning}</Fact>
                <Fact name="Account">
                  {account === null ? (
                    <span className="actor-fact__none">Its provider’s default</span>
                  ) : (
                    <span className="mono" title={info.account ?? undefined}>
                      {account}
                    </span>
                  )}
                </Fact>
                <Fact name="Version">
                  <span className="mono">{version(info.deployment.version)}</span>
                  <span className="actor-fact__none">
                    {info.pinned ? ' · pinned' : ' · follows the active'}
                  </span>
                </Fact>
                <Fact name="Created">{fullTime(info.createdAt)}</Fact>
              </dl>
            </section>
            <section className="actor-side__group" aria-labelledby="actor-cost">
              <h2 className="actor-side__title" id="actor-cost">
                Cost
              </h2>
              <p className="actor-cost__total">{total === undefined ? '—' : dollars(total)}</p>
              <dl className="actor-facts">
                <Fact name="Turns">{dollarsOf(ofKind('turn'), own.data !== undefined)}</Fact>
                <Fact name="Compaction">
                  {dollarsOf(ofKind('compaction'), own.data !== undefined)}
                </Fact>
                <Fact name="Subagents">{below === undefined ? '—' : dollars(below)}</Fact>
              </dl>
            </section>
          </>
        )}
      </aside>
    </div>
  );
}

/** What was spent on a kind of call: nothing, once it is read and there was none. */
function dollarsOf(cost: number | undefined, read: boolean): string {
  if (cost !== undefined) return dollars(cost);
  return read ? dollars(0) : '—';
}
