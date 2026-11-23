// `/audit`: what was done to the engine, and by whom, newest first, a page at a time. A filter
// under the heading narrows it to one kind of thing done. Who did it and what it was done to are
// named where the person may read their names: an email, a key's label, an agent's name.

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import type { AuditEvent, Json, PrincipalRef } from '@acentric/protocol';

import { FilterChip } from '../machines/ui.tsx';
import { may, useMe } from '../me.ts';
import { Ago, Id, LoadError, PageHeader, Pager, Table } from '../ui.tsx';
import { engine } from './api.ts';

import '../machines/machine-pane.css';

export const auditQueries = {
  page: (action: string | undefined, cursor: string | undefined) =>
    ['audit', action ?? null, cursor ?? null] as const,
  names: ['audit', 'names'] as const,
};

/** The kinds of thing the server writes down, in the filter's words. */
export const ACTIONS: readonly { readonly value: string; readonly label: string }[] = [
  { value: 'user.sign_in', label: 'Signed in' },
  { value: 'user.sign_in_failed', label: 'Failed to sign in' },
  { value: 'user.sign_out', label: 'Signed out' },
  { value: 'session.revoke', label: 'Session ended' },
  { value: 'user.setup', label: 'Engine set up' },
  { value: 'user.update', label: 'Person changed' },
  { value: 'user.delete', label: 'Person removed' },
  { value: 'user.password_change', label: 'Password changed' },
  { value: 'user.password_reset_link', label: 'Password-reset link made' },
  { value: 'user.password_reset', label: 'Password reset' },
  { value: 'invite.create', label: 'Invite made' },
  { value: 'invite.accept', label: 'Invite used' },
  { value: 'invite.revoke', label: 'Invite revoked' },
  { value: 'key.create', label: 'Key made' },
  { value: 'key.revoke', label: 'Key revoked' },
  { value: 'agent.deploy', label: 'Agent deployed' },
  { value: 'agent.activate', label: 'Deployment made active' },
  { value: 'agent.account', label: 'Agent’s account changed' },
  { value: 'agent.delete', label: 'Agent deleted' },
  { value: 'secret.set', label: 'Secret set' },
  { value: 'secret.delete', label: 'Secret removed' },
  { value: 'account.create', label: 'Model account added' },
  { value: 'account.update', label: 'Model account changed' },
  { value: 'account.delete', label: 'Model account removed' },
  { value: 'machine.create', label: 'Machine added' },
  { value: 'machine.update', label: 'Machine changed' },
  { value: 'machine.token', label: 'Enrolment token made' },
  { value: 'machine.enrol', label: 'Machine enrolled' },
  { value: 'machine.upgrade', label: 'Machine’s daemon updated' },
  { value: 'backup.made', label: 'Backup taken' },
  { value: 'backup.failed', label: 'Backup failed' },
  { value: 'machine.delete', label: 'Machine removed' },
  { value: 'sandbox_provider.create', label: 'Sandbox account added' },
  { value: 'sandbox_provider.delete', label: 'Sandbox account removed' },
  { value: 'sandbox.create', label: 'Sandbox made' },
  { value: 'sandbox.delete', label: 'Sandbox deleted' },
];

/** The names of what the log speaks of, by ID: of those the person may list. */
function useNames(): ReadonlyMap<string, string> {
  const me = useMe();
  const people = me.data !== undefined && may(me.data, 'users:manage');
  const keys = me.data !== undefined && may(me.data, 'keys:manage');
  const agents = me.data !== undefined && may(me.data, 'agents:read');
  const read = useQuery({
    queryKey: [...auditQueries.names, people, keys, agents],
    enabled: me.data !== undefined,
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const names = new Map<string, string>();
      const [users, keyList, agentList] = await Promise.all([
        people ? engine.people(signal).catch(() => undefined) : undefined,
        keys ? engine.keys(signal).catch(() => undefined) : undefined,
        agents ? engine.agents(signal).catch(() => undefined) : undefined,
      ]);
      for (const user of users?.items ?? []) names.set(user.id, user.email);
      for (const key of keyList?.items ?? []) names.set(key.id, key.label);
      for (const agent of agentList?.items ?? []) names.set(agent.id, agent.name);
      return names;
    },
  });
  return read.data ?? new Map();
}

/** One the log names: by its name where it is known, else by its ID. */
function Named({ id, names }: { id: string; names: ReadonlyMap<string, string> }) {
  const name = names.get(id);
  return name === undefined ? <Id value={id} /> : <span title={id}>{name}</span>;
}

function Who({ by, names }: { by: PrincipalRef; names: ReadonlyMap<string, string> }) {
  if (by.type === 'system') return <span className="ac-table__muted">The server</span>;
  return (
    <span>
      <Named id={by.id} names={names} />
      {by.type === 'key' && <span className="note"> key</span>}
    </span>
  );
}

/** What else the log says of it, as `name: value` pairs. Never a secret: the server keeps none here. */
export function detailText(detail: AuditEvent['detail']): string {
  if (detail === null) return '';
  const value = (each: Json): string => (typeof each === 'string' ? each : JSON.stringify(each));
  return Object.entries(detail)
    .map(([name, each]) => `${name}: ${value(each)}`)
    .join(', ');
}

export function AuditPage({
  action,
  onAction = () => {},
}: {
  /** The kind of thing done the log is narrowed to. */
  action?: string | undefined;
  onAction?: (action: string | undefined) => void;
}) {
  // The cursors of the pages before this one, and this one's: the first page has none.
  const [cursors, setCursors] = useState<readonly (string | undefined)[]>([undefined]);
  const [narrowedTo, setNarrowedTo] = useState(action);
  // A new filter starts at the first page.
  if (narrowedTo !== action) {
    setNarrowedTo(action);
    setCursors([undefined]);
  }
  const cursor = cursors.at(-1);
  const page = useQuery({
    queryKey: auditQueries.page(action, cursor),
    queryFn: ({ signal }) =>
      engine.audit(
        {
          ...(action === undefined ? {} : { action }),
          ...(cursor === undefined ? {} : { cursor }),
        },
        signal,
      ),
  });
  const names = useNames();
  const choices =
    ACTIONS.some((each) => each.value === action) || action === undefined
      ? ACTIONS
      : [...ACTIONS, { value: action, label: action }];
  const labelOf = (done: string) => ACTIONS.find((each) => each.value === done)?.label ?? done;
  const next = page.data?.nextCursor ?? null;

  return (
    <div className="list-page audit-page">
      <PageHeader title="Audit log" />
      <div className="filter-bar rise">
        <FilterChip
          name="Action"
          choices={choices}
          chosen={action === undefined ? [] : [action]}
          // One kind at a time: the server narrows the log to one.
          onToggle={(value) => onAction(value === action ? undefined : value)}
          onClear={() => onAction(undefined)}
        />
      </div>
      {page.isError && (
        <LoadError things="the audit log" error={page.error} onRetry={() => void page.refetch()} />
      )}
      <Table
        label="Audit log"
        loading={page.isPending}
        rows={page.data?.items}
        rowKey={(event) => event.id}
        columns={[
          {
            name: 'When',
            className: 'ac-table__muted',
            cell: (event) => <Ago at={event.at} />,
          },
          { name: 'Who', cell: (event) => <Who by={event.by} names={names} /> },
          {
            name: 'What',
            cell: (event) => <span title={event.action}>{labelOf(event.action)}</span>,
          },
          {
            name: 'On',
            cell: (event) =>
              event.target === null ? (
                <span className="ac-table__muted">—</span>
              ) : (
                <span>
                  <span className="note">{event.target.type} </span>
                  <Named id={event.target.id} names={names} />
                </span>
              ),
          },
          {
            name: 'Detail',
            className: 'ac-table__muted',
            cell: (event) => <span className="mono">{detailText(event.detail)}</span>,
          },
        ]}
      />
      {page.data?.items.length === 0 && (
        <p className="table-empty">
          {action === undefined ? 'Nothing has been done yet.' : 'Nothing of this kind.'}
        </p>
      )}
      <Pager
        newer={cursors.length > 1 ? () => setCursors((was) => was.slice(0, -1)) : null}
        older={next === null ? null : () => setCursors((was) => [...was, next])}
      />
    </div>
  );
}
