// The fake server's routes of the account page: a person's own name, password and sessions.

import type { Session } from '@acentric/protocol';

import { json, refused, type Area, type Call, type Shared } from './area.ts';

const NOW = 1_795_305_600_000;

/** A session of the person signed in: this browser's is `ses_1`. */
export function sessionOf(id: string, more: Partial<Session> = {}): Session {
  return {
    id: id as Session['id'],
    user: 'usr_1' as Session['user'],
    client: 'dashboard',
    label: null,
    createdAt: NOW - 3_600_000,
    lastUsedAt: NOW - 60_000,
    expiresAt: NOW + 86_400_000,
    ...more,
  };
}

export function accountArea(_shared: Shared) {
  const sessions: Session[] = [sessionOf('ses_1', { label: 'Firefox on macOS' })];
  const answer: Area['answer'] = ({ method, path, body, person }: Call) => {
    if (method === 'PATCH' && path === '/v1/me') {
      person.displayName = (body['displayName'] as string | null) ?? null;
      return json(200, {
        id: person.id,
        email: person.email,
        displayName: person.displayName,
        role: person.role,
        createdAt: NOW,
        disabledAt: null,
      });
    }
    if (method === 'POST' && path === '/v1/me/password') {
      if (body['current'] !== person.password) {
        return refused(401, 'invalid_credentials', 'The email or the password is wrong');
      }
      person.password = String(body['password']);
      sessions.splice(0, sessions.length, ...sessions.filter((one) => one.id === 'ses_1'));
      return json(204, null);
    }
    if (method === 'GET' && path === '/v1/sessions') {
      return json(200, { items: sessions, nextCursor: null });
    }
    const one = /^\/v1\/sessions\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && one !== null) {
      const at = sessions.findIndex((session) => session.id === one[1]);
      if (at === -1) return refused(404, 'not_found', 'There is no such session');
      sessions.splice(at, 1);
      return json(204, null);
    }
    return undefined;
  };
  return { sessions, answer };
}
