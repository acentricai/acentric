// The audit log, as the Audit log section of Settings reads it: the kinds of thing done in words,
// and who did it and what it was done to, named where the person may read their names: an email,
// a key's label, an agent's name.

import { useQuery } from '@tanstack/react-query';

import type { PrincipalRef } from '@acentric/protocol';

import { may, useMe } from '../me.ts';
import { Id } from '../ui.tsx';
import { engine } from './api.ts';

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
  { value: 'actor.delete', label: 'Actor deleted' },
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
  { value: 'backup.configured', label: 'Backup settings changed' },
  { value: 'backup.failed', label: 'Backup failed' },
  { value: 'retention.removed', label: 'Old data removed' },
  { value: 'machine.delete', label: 'Machine removed' },
  { value: 'sandbox_provider.create', label: 'Sandbox account added' },
  { value: 'sandbox_provider.delete', label: 'Sandbox account removed' },
  { value: 'sandbox.create', label: 'Sandbox made' },
  { value: 'sandbox.delete', label: 'Sandbox deleted' },
];

/** The names of what the log speaks of, by ID: of those the person may list. */
export function useNames(): ReadonlyMap<string, string> {
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
export function Named({ id, names }: { id: string; names: ReadonlyMap<string, string> }) {
  const name = names.get(id);
  return name === undefined ? <Id value={id} /> : <span title={id}>{name}</span>;
}

export function Who({ by, names }: { by: PrincipalRef; names: ReadonlyMap<string, string> }) {
  if (by.type === 'system') return <span className="ac-table__muted">The server</span>;
  return (
    <span>
      <Named id={by.id} names={names} />
      {by.type === 'key' && <span className="note"> key</span>}
    </span>
  );
}
