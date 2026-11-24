// People over the API: signing in, sessions, invites, roles and the audit log, called as the
// command and the dashboard call them.

import { describe, expect, it } from 'vitest';

import type { Client } from '@acentric/client';
import type { Role } from '@acentric/protocol';

import { ADMIN, BASE, api, refusal } from './api.ts';
import type { Api } from './api.ts';

const PASSWORD = 'correct horse battery';
const json = { 'content-type': 'application/json' };

/** The owner of a new engine, made by its setup link, signed in as the command signs in. */
async function owner(world: Api): Promise<{ client: Client; token: string; id: string }> {
  const token = (await world.people.setupLink()) as string;
  const signedIn = await world.as().call('setup.complete', {
    body: { token, email: 'ada@example.com', password: PASSWORD, client: 'cli' },
  });
  return {
    client: world.as(signedIn.token),
    token: signedIn.token as string,
    id: signedIn.user.id,
  };
}

/** A person an owner invited with a role, signed in as the command signs in. */
async function invited(world: Api, by: Client, role: Role, email: string) {
  const { token } = await by.call('invites.create', { body: { role } });
  const signedIn = await world.as().call('invites.accept', {
    body: { token, email, password: PASSWORD, client: 'cli' },
  });
  return { client: world.as(signedIn.token), user: signedIn.user, session: signedIn.session };
}

describe('the first person', () => {
  it('is made by the link a new server prints, once, and is its owner', async () => {
    const world = await api();
    const token = (await world.people.setupLink()) as string;
    const response = await world.app.request(`${BASE}/v1/setup`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ token, email: 'ada@example.com', password: PASSWORD, client: 'cli' }),
    });
    expect(response.status).toBe(201);
    const signedIn = (await response.json()) as { token: string; user: { role: string } };
    expect(signedIn.user.role).toBe('owner');
    expect(await world.as(signedIn.token).call('me.get')).toMatchObject({
      type: 'user',
      email: 'ada@example.com',
      role: 'owner',
    });

    const again = world.as().call('setup.complete', {
      body: { token, email: 'mallory@example.com', password: PASSWORD },
    });
    expect(await refusal(again)).toEqual({ code: 'invalid_link', status: 400 });
    // A password that is too short is refused before the link is looked at.
    expect(
      await refusal(
        world.as().call('setup.complete', { body: { token, email: 'a@b.co', password: 'short' } }),
      ),
    ).toEqual({ code: 'invalid_request', status: 400 });
  });
});

describe('signing in', () => {
  it('as the command does gives a token, which requests are then sent with', async () => {
    const world = await api();
    await owner(world);
    const signedIn = await world.as().call('auth.signIn', {
      body: { email: 'ada@example.com', password: PASSWORD, client: 'cli', label: 'a laptop' },
    });
    expect(signedIn.token).toMatch(/^as_/);
    expect(signedIn.session).toMatchObject({ client: 'cli', label: 'a laptop' });
    const client = world.as(signedIn.token);
    expect((await client.call('me.get')).type).toBe('user');
    // A person reaches the whole engine.
    expect((await client.call('agents.list')).items).toEqual([]);

    expect(await client.call('auth.signOut')).toBeUndefined();
    expect(await refusal(client.call('me.get'))).toEqual({ code: 'unauthenticated', status: 401 });
  });

  it('as the dashboard does gives a cookie its scripts cannot read, and no token', async () => {
    const world = await api();
    await owner(world);
    const response = await world.app.request(`${BASE}/v1/sign-in`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: 'ada@example.com', password: PASSWORD }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty('token');
    const set = response.headers.get('set-cookie') ?? '';
    expect(set).toMatch(
      /^acentric_session=as_[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/,
    );
    const cookie = set.split(';')[0] as string;

    const me = await world.app.request(`${BASE}/v1/me`, { headers: { cookie } });
    expect(await me.json()).toMatchObject({ type: 'user', role: 'owner' });

    // Behind HTTPS, the cookie is sent over nothing else.
    const secure = await world.app.request(`${BASE}/v1/sign-in`, {
      method: 'POST',
      headers: { ...json, 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ email: 'ada@example.com', password: PASSWORD }),
    });
    expect(secure.headers.get('set-cookie')).toMatch(/; Secure$/);
  });

  it('with a cookie changes something only from the server’s own pages', async () => {
    const world = await api();
    await owner(world);
    const signedIn = await world.app.request(`${BASE}/v1/sign-in`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: 'ada@example.com', password: PASSWORD }),
    });
    const cookie = (signedIn.headers.get('set-cookie') ?? '').split(';')[0] as string;
    const rename = (headers: { [name: string]: string }) =>
      world.app.request(`${BASE}/v1/me`, {
        method: 'PATCH',
        headers: { ...json, cookie, ...headers },
        body: JSON.stringify({ displayName: 'Ada' }),
      });

    // A page of another site, and a request that says nothing of where it is from.
    expect((await rename({ origin: 'https://evil.example' })).status).toBe(401);
    expect((await rename({})).status).toBe(401);
    const own = await rename({ origin: 'http://engine.test', host: 'engine.test' });
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({ displayName: 'Ada' });

    // Signing out ends the session, and clears the cookie.
    const out = await world.app.request(`${BASE}/v1/sign-out`, {
      method: 'POST',
      headers: { cookie, origin: 'http://engine.test', host: 'engine.test' },
    });
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toMatch(/^acentric_session=; .*Max-Age=0/);
    expect((await world.app.request(`${BASE}/v1/me`, { headers: { cookie } })).status).toBe(401);
  });

  it('is refused for a wrong password, and for a while after five of them, with how long', async () => {
    const world = await api();
    await owner(world);
    const signIn = (password: string) =>
      world.app.request(`${BASE}/v1/sign-in`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ email: 'ada@example.com', password, client: 'cli' }),
      });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = await signIn('not the password');
      expect(wrong.status).toBe(401);
      expect(await wrong.json()).toMatchObject({ error: { code: 'invalid_credentials' } });
    }
    const locked = await signIn(PASSWORD);
    expect(locked.status).toBe(429);
    expect(await locked.json()).toMatchObject({ error: { code: 'rate_limited' } });
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

describe('what a person may do', () => {
  it('is what their role may: a viewer reads, a member deploys, an admin manages people', async () => {
    const world = await api();
    const ada = await owner(world);
    const { agent } = await world.deploy('orders', 'orders@1', ada.client);
    const viewer = await invited(world, ada.client, 'viewer', 'vera@example.com');
    const member = await invited(world, ada.client, 'member', 'mel@example.com');
    const admin = await invited(world, ada.client, 'admin', 'grace@example.com');

    expect((await viewer.client.call('agents.list')).items).toHaveLength(1);
    expect(await refusal(world.deploy('orders', 'orders@2', viewer.client))).toEqual({
      code: 'forbidden',
      status: 403,
    });
    expect((await world.deploy('orders', 'orders@2', member.client)).deployment).toMatchObject({
      version: 2,
      createdBy: { type: 'user', id: member.user.id },
    });
    await member.client.call('actors.create', { params: { agent: agent.id }, body: {} });

    for (const call of [
      member.client.call('users.list'),
      member.client.call('audit.list'),
      member.client.call('invites.create', { body: { role: 'viewer' } }),
    ]) {
      expect(await refusal(call)).toEqual({ code: 'forbidden', status: 403 });
    }
    expect((await admin.client.call('users.list')).items.map((user) => user.email)).toEqual([
      'ada@example.com',
      'vera@example.com',
      'mel@example.com',
      'grace@example.com',
    ]);
  });

  it('is changed by an admin, but an admin or an owner only by an owner', async () => {
    const world = await api();
    const ada = await owner(world);
    const admin = await invited(world, ada.client, 'admin', 'grace@example.com');
    const member = await invited(world, ada.client, 'member', 'mel@example.com');
    const update = (by: Client, user: string, body: { role?: Role; disabled?: boolean }) =>
      by.call('users.update', { params: { user: user as never }, body });

    expect((await update(admin.client, member.user.id, { role: 'viewer' })).role).toBe('viewer');
    expect(await refusal(update(admin.client, member.user.id, { role: 'admin' }))).toEqual({
      code: 'forbidden',
      status: 403,
    });
    expect(await refusal(update(admin.client, ada.id, { disabled: true }))).toEqual({
      code: 'forbidden',
      status: 403,
    });
    expect(await refusal(admin.client.call('invites.create', { body: { role: 'owner' } }))).toEqual(
      { code: 'forbidden', status: 403 },
    );
    // The last owner stays one, and nobody removes themselves.
    expect(await refusal(update(ada.client, ada.id, { role: 'member' }))).toEqual({
      code: 'conflict',
      status: 409,
    });
    expect(
      await refusal(ada.client.call('users.delete', { params: { user: ada.id as never } })),
    ).toEqual({ code: 'conflict', status: 409 });
  });

  it('ends when they are disabled or removed, and so do their keys', async () => {
    const world = await api();
    const ada = await owner(world);
    const member = await invited(world, ada.client, 'member', 'mel@example.com');
    const made = await member.client.call('keys.create', {
      body: {
        label: 'hers',
        scope: { type: 'engine' },
        permissions: ['agents:deploy', 'agents:read'],
      },
    });
    expect(made.key.owner).toBe(member.user.id);
    const key = world.as(made.token);
    const params = { user: member.user.id };

    // Made a viewer, her key may do what a viewer may, and no more.
    await ada.client.call('users.update', { params, body: { role: 'viewer' } });
    expect((await key.call('me.get')).permissions).toEqual(['agents:read']);
    await ada.client.call('users.update', { params, body: { disabled: true } });
    expect(await refusal(member.client.call('me.get'))).toMatchObject({ status: 401 });
    expect(await refusal(key.call('me.get'))).toMatchObject({ status: 401 });

    await ada.client.call('users.update', { params, body: { disabled: false } });
    expect((await key.call('me.get')).type).toBe('key');
    expect(await ada.client.call('users.delete', { params })).toBeUndefined();
    expect(await refusal(key.call('me.get'))).toMatchObject({ status: 401 });
    expect(await refusal(ada.client.call('users.get', { params }))).toEqual({
      code: 'not_found',
      status: 404,
    });
  });
});

describe('an invite', () => {
  it('is made, listed, taken back, and used once', async () => {
    const world = await api();
    const ada = await owner(world);
    const first = await ada.client.call('invites.create', {
      body: { role: 'member', note: 'for Grace' },
    });
    const second = await ada.client.call('invites.create', { body: {} });
    expect(first.invite).toMatchObject({ role: 'member', note: 'for Grace' });
    expect(second.invite.role).toBe('member');
    expect((await ada.client.call('invites.list')).items.map((invite) => invite.id)).toEqual([
      first.invite.id,
      second.invite.id,
    ]);
    // Never its token again.
    expect(JSON.stringify(await ada.client.call('invites.list'))).not.toContain(first.token);

    await ada.client.call('invites.revoke', { params: { invite: second.invite.id } });
    const person = { email: 'grace@example.com', password: PASSWORD, client: 'cli' } as const;
    expect(
      await refusal(
        world.as().call('invites.accept', { body: { token: second.token, ...person } }),
      ),
    ).toEqual({ code: 'invalid_link', status: 400 });

    const grace = await world
      .as()
      .call('invites.accept', { body: { token: first.token, ...person } });
    expect(grace.user).toMatchObject({ email: 'grace@example.com', role: 'member' });
    expect(
      await refusal(
        world.as().call('invites.accept', {
          body: { token: first.token, ...person, email: 'mallory@example.com' },
        }),
      ),
    ).toEqual({ code: 'invalid_link', status: 400 });
    expect((await ada.client.call('invites.list')).items).toEqual([]);
  });

  it('with an email that is another’s is refused, and stays good', async () => {
    const world = await api();
    const ada = await owner(world);
    const { token } = await ada.client.call('invites.create', { body: {} });
    const taken = world.as().call('invites.accept', {
      body: { token, email: 'ada@example.com', password: PASSWORD },
    });
    expect(await refusal(taken)).toEqual({ code: 'conflict', status: 409 });
    expect((await ada.client.call('invites.list')).items).toHaveLength(1);
  });
});

describe('a person’s own', () => {
  it('sessions are listed, and ended one at a time', async () => {
    const world = await api();
    const ada = await owner(world);
    const other = await world.as().call('auth.signIn', {
      body: { email: 'ada@example.com', password: PASSWORD, client: 'cli', label: 'a laptop' },
    });
    const listed = await ada.client.call('sessions.list');
    expect(listed.items.map((session) => session.label)).toEqual([null, 'a laptop']);
    await ada.client.call('sessions.revoke', { params: { session: other.session.id } });
    expect(await refusal(world.as(other.token).call('me.get'))).toMatchObject({ status: 401 });
    expect((await ada.client.call('sessions.list')).items).toHaveLength(1);
  });

  it('password is changed with the one they have, and set again by a link an admin makes', async () => {
    const world = await api();
    const ada = await owner(world);
    const member = await invited(world, ada.client, 'member', 'mel@example.com');
    const signIn = (password: string) =>
      world
        .as()
        .call('auth.signIn', { body: { email: 'mel@example.com', password, client: 'cli' } });

    expect(
      await refusal(
        member.client.call('me.password', {
          body: { current: 'not it', password: 'another long one' },
        }),
      ),
    ).toEqual({ code: 'invalid_credentials', status: 401 });
    await member.client.call('me.password', {
      body: { current: PASSWORD, password: 'another long one' },
    });
    expect((await signIn('another long one')).user.id).toBe(member.user.id);

    const reset = await ada.client.call('users.resetPassword', {
      params: { user: member.user.id },
    });
    expect(
      await world.as().call('password.reset', {
        body: { token: reset.token, password: 'a third one, long enough' },
      }),
    ).toBeUndefined();
    // Everywhere she was signed in, she is not any more.
    expect(await refusal(member.client.call('me.get'))).toMatchObject({ status: 401 });
    expect((await signIn('a third one, long enough')).user.id).toBe(member.user.id);
    expect(
      await refusal(
        world
          .as()
          .call('password.reset', { body: { token: reset.token, password: 'and a fourth one' } }),
      ),
    ).toEqual({ code: 'invalid_link', status: 400 });
  });

  it('are a person’s, and not a key’s: a key has no sessions and no password', async () => {
    const world = await api();
    for (const call of [
      world.admin.call('sessions.list'),
      world.admin.call('me.update', { body: { displayName: 'A key' } }),
      world.admin.call('auth.signOut'),
    ]) {
      expect(await refusal(call)).toEqual({ code: 'forbidden', status: 403 });
    }
    // The key a server is started with can do to people what an owner can.
    expect(
      (await world.admin.call('invites.create', { body: { role: 'owner' } })).invite.role,
    ).toBe('owner');
  });
});

describe('the audit log', () => {
  it('has what was done and by whom, is read by admins, and holds no secret', async () => {
    const world = await api();
    const ada = await owner(world);
    const { agent } = await world.deploy('orders', 'orders@1', ada.client);
    await world.deploy('orders', 'orders@2', ada.client);
    await ada.client.call('agents.update', {
      params: { agent: agent.id },
      body: { activeVersion: 1 },
    });
    await ada.client.call('secrets.set', {
      params: { agent: agent.id, name: 'ORDERS_API_KEY' },
      body: { value: 'a-value-nobody-else-has' },
    });
    const made = await ada.client.call('keys.create', {
      body: { label: 'for CI', scope: { type: 'engine' }, permissions: ['agents:deploy'] },
    });
    await ada.client.call('keys.revoke', { params: { key: made.key.id } });
    await ada.client.call('secrets.delete', {
      params: { agent: agent.id, name: 'ORDERS_API_KEY' },
    });
    await ada.client.call('agents.delete', { params: { agent: agent.id } });

    const log = await ada.client.call('audit.list', { query: { limit: 100 } });
    expect(log.items.map((event) => event.action).toReversed()).toEqual([
      'user.setup',
      'agent.deploy',
      'agent.deploy',
      'agent.activate',
      'secret.set',
      'key.create',
      'key.revoke',
      'secret.delete',
      'agent.delete',
    ]);
    expect(log.items.find((event) => event.action === 'secret.set')).toMatchObject({
      by: { type: 'user', id: ada.id },
      target: { type: 'agent', id: agent.id },
      detail: { name: 'ORDERS_API_KEY' },
    });
    const written = JSON.stringify(log);
    for (const secret of ['a-value-nobody-else-has', PASSWORD, ada.token, made.token]) {
      expect(written).not.toContain(secret);
    }

    // One kind of it, and a page at a time.
    const deploys = await ada.client.call('audit.list', {
      query: { action: 'agent.deploy', limit: 1 },
    });
    expect(deploys.items).toHaveLength(1);
    const rest = await ada.client.call('audit.list', {
      query: { action: 'agent.deploy', limit: 1, cursor: deploys.nextCursor ?? '' },
    });
    expect(rest).toMatchObject({ items: [{ action: 'agent.deploy' }], nextCursor: null });
    // What the key a server was started with does is written down as that key's.
    await world.deploy('billing', 'billing@1');
    const [latest] = (await world.admin.call('audit.list', { query: { limit: 1 } })).items;
    expect(latest).toMatchObject({ action: 'agent.deploy', by: { type: 'key' } });
    expect(ADMIN).not.toBe('');
  });
});

describe('a picture of a person', () => {
  /** The first bytes of a PNG, and some more: what is looked at to know it is one. */
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

  it('is given by its person, shown to anyone signed in, and taken away', async () => {
    const world = await api();
    const ada = await owner(world);
    const auth = { authorization: `Bearer ${ada.token}` };
    const put = (body: Uint8Array, type = 'image/png') =>
      world.app.request(`${BASE}/v1/me/photo`, {
        method: 'PUT',
        headers: { ...auth, 'content-type': type },
        body,
      });

    const given = await put(PNG);
    expect(given.status).toBe(200);
    const user = (await given.json()) as { photo: string | null };
    expect(user.photo).toMatch(/^[0-9a-f]{16}$/);
    expect((await ada.client.call('users.get', { params: { user: ada.id as never } })).photo).toBe(
      user.photo,
    );

    const shown = await world.app.request(
      `${BASE}/v1/users/${ada.id}/photo?v=${String(user.photo)}`,
      { headers: auth },
    );
    expect(shown.status).toBe(200);
    expect(shown.headers.get('content-type')).toBe('image/png');
    expect(shown.headers.get('cache-control')).toContain('immutable');
    expect(new Uint8Array(await shown.arrayBuffer())).toEqual(PNG);
    // Not to one who is not signed in.
    expect((await world.app.request(`${BASE}/v1/users/${ada.id}/photo`)).status).toBe(401);

    // What it is, is what its bytes say: not what it is called.
    const text = await put(new TextEncoder().encode('<svg onload="alert(1)"/>'), 'image/png');
    expect(text.status).toBe(400);
    const large = await put(new Uint8Array(2 * 1024 * 1024 + 1));
    expect(large.status).toBe(413);

    const removed = await world.app.request(`${BASE}/v1/me/photo`, {
      method: 'DELETE',
      headers: auth,
    });
    expect(((await removed.json()) as { photo: string | null }).photo).toBeNull();
    expect(
      (await world.app.request(`${BASE}/v1/users/${ada.id}/photo`, { headers: auth })).status,
    ).toBe(404);
  });
});

describe('a session a browser signs in with', () => {
  it('is named by the browser when its sign-in names it nothing', async () => {
    const world = await api();
    await owner(world);
    const response = await world.app.request(`${BASE}/v1/sign-in`, {
      method: 'POST',
      headers: {
        ...json,
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({ email: 'ada@example.com', password: PASSWORD }),
    });
    expect(((await response.json()) as { session: { label: string } }).session.label).toBe(
      'Chrome (Mac OS X)',
    );
  });
});
