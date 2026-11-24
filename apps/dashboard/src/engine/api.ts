// The server's calls the Engine section's pages make: API keys, people and their invites, the
// server's backups, and the audit log.

import type { CreateKeyRequest, Role } from '@acentric/protocol';

import { api } from '../api.ts';

export { errorText, isApiError, queryClient } from '../api.ts';

const withSignal = (signal?: AbortSignal) => (signal === undefined ? {} : { signal });

/** As many as one page holds: more keys, people or invites than a page of them shows. */
const ALL = 200;

export const engine = {
  // API keys
  keys: (signal?: AbortSignal) =>
    api.call('keys.list', { query: { limit: ALL }, ...withSignal(signal) }),
  createKey: (body: CreateKeyRequest) => api.call('keys.create', { body }),
  revokeKey: (key: string) => api.call('keys.revoke', { params: { key: key as never } }),

  // What a key's scope is chosen from
  agents: (signal?: AbortSignal) =>
    api.call('agents.list', { query: { limit: ALL }, ...withSignal(signal) }),
  /** Every actor, of every agent, as many as a page holds: a key of one actor is for one. */
  allActors: (signal?: AbortSignal) =>
    api.call('actors.list', { query: { limit: ALL }, ...withSignal(signal) }),
  actorsOf: (agent: string, signal?: AbortSignal) =>
    api.call('actors.list', {
      query: { agent: agent as never, limit: ALL },
      ...withSignal(signal),
    }),

  // People
  people: (signal?: AbortSignal) =>
    api.call('users.list', { query: { limit: ALL }, ...withSignal(signal) }),
  changePerson: (user: string, body: { role?: Role; disabled?: boolean }) =>
    api.call('users.update', { params: { user: user as never }, body }),
  resetLink: (user: string) => api.call('users.resetPassword', { params: { user: user as never } }),
  removePerson: (user: string) => api.call('users.delete', { params: { user: user as never } }),
  invites: (signal?: AbortSignal) =>
    api.call('invites.list', { query: { limit: ALL }, ...withSignal(signal) }),
  invite: (role: Role, note: string | undefined) =>
    api.call('invites.create', { body: { role, ...(note === undefined ? {} : { note }) } }),
  revokeInvite: (invite: string) =>
    api.call('invites.revoke', { params: { invite: invite as never } }),

  // Backups
  backups: (signal?: AbortSignal) => api.call('backups.list', withSignal(signal)),
  takeBackup: () => api.call('backups.create'),

  // The audit log
  audit: (query: { action?: string; cursor?: string }, signal?: AbortSignal) =>
    api.call('audit.list', {
      query: {
        limit: 50,
        ...(query.action === undefined ? {} : { action: query.action }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      },
      ...withSignal(signal),
    }),
};

/** The dashboard's page a link of the server's ends at, with what it is used once by. */
export function linkTo(page: 'invite' | 'reset', token: string): string {
  return `${window.location.origin}/${page}?token=${encodeURIComponent(token)}`;
}
