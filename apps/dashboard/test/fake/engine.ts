// The fake server's routes of the dashboard's Engine section: API keys, people and their invites,
// and the audit log, refusing what the server refuses.

import { HOLDABLE, isAtLeast, ROLE_PERMISSIONS } from '@acentric/protocol';
import type {
  AuditEvent,
  Backup,
  Backups,
  Invite,
  Key,
  Permission,
  Role,
  Scope,
  User,
} from '@acentric/protocol';

import { json, refused, type Area, type Call, type Person, type Shared } from './area.ts';

const NOW = 1_795_305_600_000;
const DAY = 86_400_000;

/** An ID of a kind, as the server makes them: its prefix and 26 characters. */
export const idOf = (prefix: string, n: number) => `${prefix}_${String(n).padStart(26, '0')}`;

/** An event of the audit log, newest made last. */
export function eventOf(n: number, more: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: idOf('aud', n) as AuditEvent['id'],
    at: NOW + n * 1000,
    by: { type: 'system' },
    action: 'user.sign_in',
    target: null,
    detail: null,
    ...more,
  };
}

export function engineArea(shared: Shared) {
  const keys: Key[] = [];
  const invites: Invite[] = [];
  /** When each person was disabled, by their ID. */
  const disabled = new Map<string, number>();
  const audit: AuditEvent[] = [];
  /** The server's backups, as GET /v1/backups says them; null for a server with them off. */
  const backups: { status: Backups | null; fail: string | null } = {
    status: {
      dir: '/data/backups',
      sameDisk: true,
      everyMs: 86_400_000,
      keep: 3,
      next: NOW + 3_600_000,
      last: null,
      bucket: null,
      items: [],
    },
    fail: null,
  };
  let made = 0;

  const userOf = (person: Person): User => ({
    id: person.id as User['id'],
    email: person.email,
    displayName: null,
    role: person.role,
    createdAt: NOW,
    disabledAt: disabled.get(person.id) ?? null,
    photo: null,
  });
  const personBy = (id: string) => [...shared.people.values()].find((one) => one.id === id);
  const forbidden = (message: string) => refused(403, 'forbidden', message);
  const conflict = (message: string) => refused(409, 'conflict', message);
  /** Only an owner changes, or makes, an admin or an owner. */
  const outranked = (by: Person, role: Role) => isAtLeast(role, 'admin') && by.role !== 'owner';

  const answer = ({ method, path, body, query, person: by }: Call): Response | undefined => {
    // Backups
    if (path === '/v1/backups') {
      const status = backups.status;
      if (status === null) {
        return refused(
          503,
          'unavailable',
          'This server takes no backups of its own: ACENTRIC_BACKUP_EVERY is off',
        );
      }
      if (method === 'GET') return json(200, status);
      if (method === 'POST') {
        if (backups.fail !== null) {
          status.last = { ok: false, at: NOW, error: backups.fail };
          return refused(500, 'internal', backups.fail);
        }
        made += 1;
        const backup: Backup = {
          name: `acentric-2026-11-23T12-00-0${String(made)}Z-manual-0.15.0.tar`,
          kind: 'manual',
          version: '0.15.0',
          createdAt: NOW,
          bytes: 5 * 1_048_576,
          onServer: true,
          inBucket: status.bucket !== null,
        };
        status.items.unshift(backup);
        status.last = { ok: true, at: NOW, name: backup.name };
        return json(201, backup);
      }
    }
    // API keys
    if (method === 'GET' && path === '/v1/keys')
      return json(200, { items: keys, nextCursor: null });
    if (method === 'POST' && path === '/v1/keys') {
      const scope = body['scope'] as Scope;
      const permissions = body['permissions'] as Permission[];
      for (const permission of permissions) {
        if (!HOLDABLE[scope.type].includes(permission)) {
          return refused(
            400,
            'invalid_request',
            `A key for one ${scope.type} cannot hold ${permission}`,
          );
        }
        if (!ROLE_PERMISSIONS[by.role].includes(permission)) {
          return forbidden(`It does not hold ${permission}, so it cannot give it`);
        }
      }
      made += 1;
      const key: Key = {
        id: idOf('key', made) as Key['id'],
        label: String(body['label']),
        owner: by.id as Key['owner'],
        scope,
        permissions,
        expiresAt: typeof body['expiresAt'] === 'number' ? body['expiresAt'] : null,
        createdBy: { type: 'user', id: by.id as never },
        createdAt: NOW,
        lastUsedAt: null,
      };
      keys.push(key);
      return json(201, { key, token: `ak_${key.id.slice(4)}_secret-${String(made)}` });
    }
    const aKey = /^\/v1\/keys\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && aKey !== null) {
      const at = keys.findIndex((key) => key.id === aKey[1]);
      if (at < 0) return refused(404, 'not_found', 'There is no such key');
      keys.splice(at, 1);
      return json(204, null);
    }

    // People
    if (method === 'GET' && path === '/v1/users') {
      return json(200, { items: [...shared.people.values()].map(userOf), nextCursor: null });
    }
    const aUser = /^\/v1\/users\/([^/]+)(\/password-reset)?$/.exec(path);
    const them = aUser === null ? undefined : personBy(aUser[1] ?? '');
    if (aUser !== null && them === undefined)
      return refused(404, 'not_found', 'There is no such person');
    if (aUser !== null && them !== undefined) {
      if (outranked(by, them.role)) return forbidden('Only an owner changes an admin or an owner');
      const lastOwner = () =>
        [...shared.people.values()].filter(
          (one) => one.id !== them.id && one.role === 'owner' && !disabled.has(one.id),
        ).length === 0;
      if (method === 'POST' && aUser[2] !== undefined) {
        return json(201, { token: `reset-${them.id}`, expiresAt: NOW + DAY });
      }
      if (method === 'PATCH') {
        const role = (body['role'] as Role | undefined) ?? them.role;
        const disable = body['disabled'] as boolean | undefined;
        if (outranked(by, role)) return forbidden('Only an owner makes an admin or an owner');
        const lessens = role !== them.role || disable === true;
        if (lessens && them.id === by.id) {
          return conflict('Nobody changes their own role, or disables themselves');
        }
        if (lessens && them.role === 'owner' && lastOwner()) {
          return conflict('An engine always has an owner who can sign in: this is the last one');
        }
        them.role = role;
        if (disable === true) disabled.set(them.id, NOW);
        if (disable === false) disabled.delete(them.id);
        return json(200, userOf(them));
      }
      if (method === 'DELETE') {
        if (them.id === by.id) return conflict('Nobody removes themselves');
        if (them.role === 'owner' && lastOwner()) {
          return conflict('An engine always has an owner who can sign in: this is the last one');
        }
        shared.people.delete(them.email);
        return json(204, null);
      }
    }

    // Invites
    if (method === 'GET' && path === '/v1/invites')
      return json(200, { items: invites, nextCursor: null });
    if (method === 'POST' && path === '/v1/invites') {
      const role = (body['role'] as Role | undefined) ?? 'member';
      if (outranked(by, role)) return forbidden('Only an owner makes an admin or an owner');
      made += 1;
      const invite: Invite = {
        id: idOf('inv', made) as Invite['id'],
        role,
        note: typeof body['note'] === 'string' ? body['note'] : null,
        createdBy: { type: 'user', id: by.id as never },
        createdAt: NOW,
        expiresAt: NOW + 7 * DAY,
      };
      invites.push(invite);
      return json(201, { invite, token: `invite-${String(made)}` });
    }
    const anInvite = /^\/v1\/invites\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && anInvite !== null) {
      const at = invites.findIndex((invite) => invite.id === anInvite[1]);
      if (at < 0) return refused(404, 'not_found', 'There is no such invite');
      invites.splice(at, 1);
      return json(204, null);
    }

    // The audit log, newest first, from after the cursor
    if (method === 'GET' && path === '/v1/audit-events') {
      const action = query.get('action');
      const cursor = query.get('cursor');
      const limit = Number(query.get('limit') ?? 50);
      const rest = audit
        .toSorted((a, b) => (a.id < b.id ? 1 : -1))
        .filter(
          (event) =>
            (action === null || event.action === action) && (cursor === null || event.id < cursor),
        );
      const items = rest.slice(0, limit);
      return json(200, {
        items,
        nextCursor: rest.length > limit ? (items.at(-1)?.id ?? null) : null,
      });
    }
    return undefined;
  };

  return { answer, keys, invites, audit, disabled, backups } satisfies Area &
    Record<string, unknown>;
}
