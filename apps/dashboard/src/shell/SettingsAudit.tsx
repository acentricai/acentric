// The Audit log section of Settings, for one who may read it: what was done to the engine, and
// by whom, newest first, a page at a time, narrowed to one kind of thing done. It reads what the
// Audit log page reads.

import { useQuery } from '@tanstack/react-query';
import { Fragment, useState } from 'react';

import type { AuditEvent, Json } from '@acentric/protocol';

import { engine } from '../engine/api.ts';
import { ACTIONS, Named, Who, auditQueries, useNames } from '../engine/audit.tsx';
import { everyText } from '../engine/backups.tsx';
import { fullTime, longTime, size } from '../format.ts';
import { Ago, Button, Dialog, Dropdown, LoadError, Pager, Skeleton } from '../ui.tsx';

const ALL = 'all';
const CHOICES = [{ value: ALL, label: 'All actions' }, ...ACTIONS];

export function AuditSettings() {
  const [action, setAction] = useState(ALL);
  // The cursors of the pages before this one, and this one's: the first page has none.
  const [cursors, setCursors] = useState<readonly (string | undefined)[]>([undefined]);
  const narrowed = action === ALL ? undefined : action;
  const cursor = cursors.at(-1);
  const page = useQuery({
    queryKey: auditQueries.page(narrowed, cursor),
    queryFn: ({ signal }) =>
      engine.audit(
        {
          ...(narrowed === undefined ? {} : { action: narrowed }),
          ...(cursor === undefined ? {} : { cursor }),
        },
        signal,
      ),
  });
  const names = useNames();
  const next = page.data?.nextCursor ?? null;
  const [shown, setShown] = useState<AuditEvent | null>(null);

  return (
    <div className="prefs-page">
      <section className="prefs-group" aria-labelledby="prefs-audit">
        <div className="prefs-group__head prefs-group__head--spaced">
          <h3 className="prefs-group__title" id="prefs-audit">
            Audit log
          </h3>
          <div className="prefs-filter">
            <Dropdown
              label="Action"
              value={action}
              options={CHOICES}
              onChange={(value) => {
                setAction(value);
                // A new filter starts at the first page.
                setCursors([undefined]);
              }}
            />
          </div>
        </div>
        {page.isPending ? (
          <Skeleton rows={5} label="Loading the audit log" />
        ) : page.isError ? (
          <LoadError
            things="the audit log"
            error={page.error}
            onRetry={() => void page.refetch()}
          />
        ) : (
          <>
            <table className="prefs-table" aria-label="Audit log">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Who</th>
                  <th scope="col">What</th>
                  <th scope="col">On</th>
                </tr>
              </thead>
              <tbody>
                {page.data.items.map((event) => (
                  <tr
                    key={event.id}
                    className="prefs-table__open"
                    tabIndex={0}
                    aria-label={`${labelOf(event.action)}, ${fullTime(event.at)}`}
                    onClick={() => setShown(event)}
                    onKeyDown={(key) => {
                      if (key.key === 'Enter' || key.key === ' ') {
                        key.preventDefault();
                        setShown(event);
                      }
                    }}
                  >
                    <td title={fullTime(event.at)}>
                      <Ago at={event.at} />
                    </td>
                    <td>
                      <span className="prefs-table__cut">
                        <Who by={event.by} names={names} />
                      </span>
                    </td>
                    <td>{labelOf(event.action)}</td>
                    <td>
                      {event.target === null ? (
                        '—'
                      ) : (
                        <span className="prefs-table__cut">
                          <Named id={event.target.id} names={names} />
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {page.data.items.length === 0 && (
              <p className="prefs-empty">
                {narrowed === undefined ? 'Nothing has been done yet' : 'Nothing of this kind'}
              </p>
            )}
            <div className="prefs-pager">
              <Pager
                newer={cursors.length > 1 ? () => setCursors((was) => was.slice(0, -1)) : null}
                older={next === null ? null : () => setCursors((was) => [...was, next])}
              />
            </div>
          </>
        )}
      </section>
      {shown !== null && <EventDialog event={shown} names={names} onClose={() => setShown(null)} />}
    </div>
  );
}

const labelOf = (done: string) => ACTIONS.find((each) => each.value === done)?.label ?? done;

/** A name the log gives a detail, as words: `everyMs` and `client_id` as Every and Client id. */
function wordsOf(name: string): string {
  const words = name
    .replace(/Ms$/, '')
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
  if (name === 'ms') return 'Took';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A detail's value, as it reads best: sizes, times and durations as such, the rest as JSON. */
function Value({ name, value }: { name: string; value: Json }) {
  if (typeof value === 'boolean') return <>{value ? 'Yes' : 'No'}</>;
  if (typeof value === 'number') {
    if (name === 'bytes') return <>{size(value)}</>;
    if (name === 'ms') return <>{`${String(value)} ms`}</>;
    if (name.endsWith('Ms')) return <>{everyText(value).replace(/^every/, 'Every')}</>;
    if (name.endsWith('At')) return <>{longTime(value)}</>;
    return <>{value.toLocaleString()}</>;
  }
  if (typeof value === 'string') return <>{value}</>;
  if (value === null) return <>—</>;
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}

/** One event of the log, all it says. */
function EventDialog({
  event,
  names,
  onClose,
}: {
  event: AuditEvent;
  names: ReadonlyMap<string, string>;
  onClose: () => void;
}) {
  return (
    <Dialog
      title={labelOf(event.action)}
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose} data-autofocus>
          Done
        </Button>
      }
    >
      <dl className="prefs-facts">
        <dt>When</dt>
        <dd>{longTime(event.at)}</dd>
        <dt>Who</dt>
        <dd>
          <Who by={event.by} names={names} />
        </dd>
        <dt>Action</dt>
        <dd className="mono">{event.action}</dd>
        {event.target !== null && (
          <>
            <dt>On</dt>
            <dd>
              {event.target.type} <Named id={event.target.id} names={names} />
            </dd>
          </>
        )}
        {Object.entries(event.detail ?? {}).map(([name, value]) => (
          <Fragment key={name}>
            <dt>{wordsOf(name)}</dt>
            <dd>
              <Value name={name} value={value} />
            </dd>
          </Fragment>
        ))}
      </dl>
    </Dialog>
  );
}
