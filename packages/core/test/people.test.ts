import { describe, expect, it } from 'vitest';

import { ROLE_PERMISSIONS } from '@acentric/protocol';
import type { Principal } from '@acentric/protocol';

import { Audit } from '../src/audit.ts';
import { Keys } from '../src/keys.ts';
import { MemoryStore } from '../src/memory-store.ts';
import { People } from '../src/people.ts';
import type { SignedIn, UserPrincipal } from '../src/people.ts';

const NOW = 1_795_305_600_000;
const DAY = 86_400_000;
const PASSWORD = 'correct horse battery';

function world() {
  let now = NOW;
  const store = new MemoryStore();
  const clock = () => now;
  const audit = new Audit({ store, clock });
  // A hash that is quick to make: these tests are not of how long a password takes to guess.
  const people = new People({ store, audit, clock, passwordCost: 1024 });
  const keys = new Keys({
    store,
    settingsKey: 'a-key-an-operator-keeps-somewhere-safe',
    agentOf: async () => undefined,
    holderOf: (user) => people.holder(user),
    clock,
  });
  /** The owner, made by the link a new engine prints. */
  const owner = async () => {
    const token = (await people.setupLink()) as string;
    return people.setup({ token, email: 'ada@example.com', password: PASSWORD, client: 'cli' });
  };
  /** A person an owner invited, signed in. */
  const invited = async (
    by: Principal,
    role: 'viewer' | 'member' | 'admin' | 'owner',
    email: string,
  ) => {
    const { token } = await people.invite(by, { role });
    return people.accept({ token, email, password: PASSWORD, client: 'dashboard' });
  };
  const as = (signedIn: SignedIn): Promise<UserPrincipal> => people.authenticate(signedIn.token);
  const actions = async () =>
    (await audit.list({ limit: 100 })).items.map((event) => event.action).toReversed();
  return {
    store,
    people,
    keys,
    audit,
    owner,
    invited,
    as,
    actions,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('an engine with no person yet', () => {
  it('makes a link, once used, that makes its owner and signs them in', async () => {
    const { people, as } = world();
    const token = (await people.setupLink()) as string;
    expect(token).toMatch(/^al_[0-9a-z]{26}_[A-Za-z0-9_-]{43}$/);
    const signedIn = await people.setup({
      token,
      email: ' Ada@Example.com ',
      password: PASSWORD,
      displayName: 'Ada',
      client: 'dashboard',
      label: 'Firefox',
    });
    expect(signedIn.user).toMatchObject({
      email: 'ada@example.com',
      displayName: 'Ada',
      role: 'owner',
      disabledAt: null,
    });
    expect(signedIn.session).toMatchObject({ client: 'dashboard', label: 'Firefox' });
    expect(await as(signedIn)).toEqual({
      type: 'user',
      user: signedIn.user.id,
      email: 'ada@example.com',
      displayName: 'Ada',
      role: 'owner',
      permissions: [...ROLE_PERMISSIONS.owner],
      session: signedIn.session.id,
    });
    // Used once: it makes no second owner, and an engine with a person makes no such link.
    await expect(
      people.setup({ token, email: 'mallory@example.com', password: PASSWORD, client: 'cli' }),
    ).rejects.toMatchObject({ code: 'invalid_link' });
    expect(await people.setupLink()).toBeUndefined();
  });

  it('makes a new link each time it starts, in place of the one before', async () => {
    const { people } = world();
    const first = (await people.setupLink()) as string;
    const second = (await people.setupLink()) as string;
    const person = { email: 'ada@example.com', password: PASSWORD, client: 'cli' } as const;
    await expect(people.setup({ token: first, ...person })).rejects.toMatchObject({
      code: 'invalid_link',
    });
    expect((await people.setup({ token: second, ...person })).user.role).toBe('owner');
  });

  it('refuses a link that is not one, is of another kind, or has expired', async () => {
    const { people, owner, advance } = world();
    const person = { email: 'grace@example.com', password: PASSWORD, client: 'cli' } as const;
    await expect(people.setup({ token: 'not-a-link', ...person })).rejects.toMatchObject({
      code: 'invalid_link',
    });
    const ada = await owner();
    const { token } = await people.invite(await people.authenticate(ada.token), { role: 'member' });
    // An invite is no setup link, and with one character changed it is no invite.
    await expect(people.setup({ token, ...person })).rejects.toMatchObject({
      code: 'invalid_link',
    });
    const last = token.at(-1) === 'A' ? 'B' : 'A';
    await expect(
      people.accept({ token: token.slice(0, -1) + last, ...person }),
    ).rejects.toMatchObject({ code: 'invalid_link' });
    advance(7 * DAY);
    await expect(people.accept({ token, ...person })).rejects.toMatchObject({
      code: 'invalid_link',
    });
  });
});

describe('signing in', () => {
  it('is by email and password, and gives a session whose token a request is then from', async () => {
    const { people, owner, store } = world();
    const ada = await owner();
    const again = await people.signIn({
      email: 'ADA@example.com',
      password: PASSWORD,
      client: 'cli',
      label: 'a laptop',
    });
    expect(again.user.id).toBe(ada.user.id);
    expect(again.token).toMatch(/^as_[0-9a-z]{26}_[A-Za-z0-9_-]{43}$/);
    expect(again.session.expiresAt).toBe(NOW + 90 * DAY);
    expect((await people.authenticate(again.token)).session).toBe(again.session.id);
    expect(await people.sessions(ada.user.id)).toHaveLength(2);
    // Neither a password nor a token is kept: only what tells each is the one.
    const kept = JSON.stringify([
      await store.loadUser(ada.user.id),
      await store.loadSession(again.session.id),
    ]);
    expect(kept).not.toContain(PASSWORD);
    expect(kept).not.toContain(again.token.slice(again.token.indexOf('_', 3) + 1));
  });

  it('is refused the same way for a wrong password, no such person, and one who is disabled', async () => {
    const { people, owner, invited, as } = world();
    const ada = await as(await owner());
    const grace = await invited(ada, 'member', 'grace@example.com');
    await people.update(ada, grace.user.id, { disabled: true });
    for (const [email, password] of [
      ['ada@example.com', 'the wrong password'],
      ['nobody@example.com', PASSWORD],
      ['grace@example.com', PASSWORD],
    ] as const) {
      const refused = people.signIn({ email, password, client: 'cli' });
      await expect(refused, email).rejects.toMatchObject({ code: 'invalid_credentials' });
      await expect(refused, email).rejects.toThrow('The email and the password are not');
    }
  });

  it('is refused for a while after it failed five times, whatever is given then', async () => {
    const { people, owner, advance } = world();
    await owner();
    const signIn = (password: string) =>
      people.signIn({ email: 'ada@example.com', password, client: 'cli' });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(signIn('wrong')).rejects.toMatchObject({ code: 'invalid_credentials' });
    }
    // Even the right password, now.
    await expect(signIn(PASSWORD)).rejects.toMatchObject({
      code: 'rate_limited',
      retryAfterMs: 30_000,
    });
    advance(30_000);
    // One more failure, and the wait is twice as long.
    await expect(signIn('wrong')).rejects.toMatchObject({ code: 'invalid_credentials' });
    await expect(signIn(PASSWORD)).rejects.toMatchObject({ retryAfterMs: 60_000 });
    advance(60_000);
    expect((await signIn(PASSWORD)).user.email).toBe('ada@example.com');
    // Signed in, the count starts again.
    await expect(signIn('wrong')).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect((await signIn(PASSWORD)).user.email).toBe('ada@example.com');
  });
});

describe('failed sign-ins', () => {
  it('are kept up to a number, and one refused now is kept past emails tried at random', async () => {
    const store = new MemoryStore();
    const people = new People({ store, passwordCost: 1024, keptFailures: 3 });
    const token = (await people.setupLink()) as string;
    await people.setup({ token, email: 'ada@example.com', password: PASSWORD, client: 'cli' });
    const signIn = (email: string, password = 'wrong') =>
      people.signIn({ email, password, client: 'cli' });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(signIn('ada@example.com')).rejects.toMatchObject({
        code: 'invalid_credentials',
      });
    }
    for (let one = 0; one < 20; one += 1) {
      await expect(signIn(`someone-${String(one)}@example.com`)).rejects.toMatchObject({
        code: 'invalid_credentials',
      });
      expect(people.failing).toBeLessThanOrEqual(3);
    }
    // Ada is refused still, with the right password too.
    await expect(signIn('ada@example.com', PASSWORD)).rejects.toMatchObject({
      code: 'rate_limited',
    });
  });
});

describe('a session', () => {
  it('lasts from when it was last used: a month for the dashboard', async () => {
    const { people, owner, as, store, advance } = world();
    const ada = await owner();
    const dashboard = await people.signIn({
      email: 'ada@example.com',
      password: PASSWORD,
      client: 'dashboard',
    });
    expect(dashboard.session.expiresAt).toBe(NOW + 30 * DAY);
    advance(29 * DAY);
    await as(dashboard);
    // Used a day before it would have ended, it lasts a month from then.
    await expect
      .poll(async () => (await store.loadSession(dashboard.session.id))?.session.expiresAt)
      .toBe(NOW + 59 * DAY);
    advance(30 * DAY);
    await expect(as(dashboard)).rejects.toMatchObject({ code: 'unauthenticated' });
    // The command's lasts three months, and was not used since.
    expect((await as(ada)).user).toBe(ada.user.id);
  });

  it('is ended by signing out, and one of a person’s own by naming it', async () => {
    const { people, owner, invited, as } = world();
    const first = await owner();
    const ada = await as(first);
    const second = await people.signIn({
      email: 'ada@example.com',
      password: PASSWORD,
      client: 'cli',
    });
    const grace = await invited(ada, 'member', 'grace@example.com');

    await people.endSession(ada, second.session.id);
    await expect(as(second)).rejects.toMatchObject({ code: 'unauthenticated' });
    // Another's session is, to them, not there.
    await expect(people.endSession(ada, grace.session.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    await people.signOut(ada);
    await expect(as(first)).rejects.toMatchObject({ code: 'unauthenticated' });
    expect((await as(grace)).email).toBe('grace@example.com');
  });

  it('is refused when its token is not one, or is another’s with one character changed', async () => {
    const { people, owner } = world();
    const { token } = await owner();
    const last = token.at(-1) === 'A' ? 'B' : 'A';
    for (const sent of [
      '',
      'not a token',
      `${token.slice(0, -1)}${last}`,
      token.replace('as_', 'al_'),
    ]) {
      await expect(people.authenticate(sent), sent).rejects.toMatchObject({
        code: 'unauthenticated',
      });
    }
  });
});

describe('an invite', () => {
  it('makes one account with its role, by a link its maker passes on', async () => {
    const { people, owner, as } = world();
    const ada = await as(await owner());
    const { invite, token } = await people.invite(ada, { role: 'viewer', note: 'for Grace' });
    expect(invite).toMatchObject({
      role: 'viewer',
      note: 'for Grace',
      createdBy: { type: 'user', id: ada.user },
      expiresAt: NOW + 7 * DAY,
    });
    expect(await people.invites()).toEqual([invite]);

    const grace = await people.accept({
      token,
      email: 'grace@example.com',
      password: PASSWORD,
      client: 'dashboard',
    });
    expect(grace.user).toMatchObject({ email: 'grace@example.com', role: 'viewer' });
    expect((await as(grace)).permissions).toEqual([...ROLE_PERMISSIONS.viewer]);
    expect(await people.invites()).toEqual([]);
    await expect(
      people.accept({ token, email: 'mallory@example.com', password: PASSWORD, client: 'cli' }),
    ).rejects.toMatchObject({ code: 'invalid_link' });
  });

  it('stays good when the email it was used with is another’s', async () => {
    const { people, owner, as } = world();
    const ada = await as(await owner());
    const { token } = await people.invite(ada, { role: 'member' });
    const person = { token, password: PASSWORD, client: 'cli' } as const;
    await expect(people.accept({ ...person, email: 'ada@example.com' })).rejects.toMatchObject({
      code: 'conflict',
    });
    expect((await people.accept({ ...person, email: 'grace@example.com' })).user.role).toBe(
      'member',
    );
  });

  it('is taken back, and then makes no account', async () => {
    const { people, owner, as } = world();
    const ada = await as(await owner());
    const { invite, token } = await people.invite(ada, { role: 'member' });
    await people.revokeInvite(ada, invite.id);
    await expect(
      people.accept({ token, email: 'grace@example.com', password: PASSWORD, client: 'cli' }),
    ).rejects.toMatchObject({ code: 'invalid_link' });
    await expect(people.revokeInvite(ada, invite.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('of an admin or an owner is made by an owner alone', async () => {
    const { people, owner, invited, as } = world();
    const ada = await as(await owner());
    const admin = await as(await invited(ada, 'admin', 'grace@example.com'));
    expect((await people.invite(admin, { role: 'member' })).invite.role).toBe('member');
    for (const role of ['admin', 'owner'] as const) {
      await expect(people.invite(admin, { role })).rejects.toMatchObject({ code: 'forbidden' });
    }
    expect((await people.invite(ada, { role: 'owner' })).invite.role).toBe('owner');
  });
});

describe('a password', () => {
  it('is changed by its person, who is then signed out everywhere else', async () => {
    const { people, owner, as } = world();
    const here = await owner();
    const elsewhere = await people.signIn({
      email: 'ada@example.com',
      password: PASSWORD,
      client: 'cli',
    });
    const ada = await as(here);
    await expect(
      people.changePassword(ada, { current: 'not it', password: 'another long one' }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
    await people.changePassword(ada, { current: PASSWORD, password: 'another long one' });

    expect((await as(here)).user).toBe(ada.user);
    await expect(as(elsewhere)).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(
      people.signIn({ email: 'ada@example.com', password: PASSWORD, client: 'cli' }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
    const signedIn = await people.signIn({
      email: 'ada@example.com',
      password: 'another long one',
      client: 'cli',
    });
    expect(signedIn.user.id).toBe(ada.user);
  });

  it('that was lost is set again by a link an admin makes, once, for a day', async () => {
    const { people, owner, invited, as, advance } = world();
    const ada = await as(await owner());
    const grace = await invited(ada, 'member', 'grace@example.com');
    const { token, expiresAt } = await people.resetLink(ada, grace.user.id);
    expect(expiresAt).toBe(NOW + DAY);

    await people.reset({ token, password: 'a new one, long enough' });
    // Wherever she was signed in, she is not any more.
    await expect(as(grace)).rejects.toMatchObject({ code: 'unauthenticated' });
    const signedIn = await people.signIn({
      email: 'grace@example.com',
      password: 'a new one, long enough',
      client: 'cli',
    });
    expect(signedIn.user.id).toBe(grace.user.id);
    await expect(people.reset({ token, password: 'and another one' })).rejects.toMatchObject({
      code: 'invalid_link',
    });

    const late = await people.resetLink(ada, grace.user.id);
    advance(DAY);
    await expect(
      people.reset({ token: late.token, password: 'far too late' }),
    ).rejects.toMatchObject({ code: 'invalid_link' });
  });

  it('of an owner who is locked out is set again by a link made on the server itself', async () => {
    const { people, owner } = world();
    await owner();
    const { token } = await people.resetLinkFor('Ada@example.com');
    await people.reset({ token, password: 'back in again, at last' });
    const signedIn = await people.signIn({
      email: 'ada@example.com',
      password: 'back in again, at last',
      client: 'cli',
    });
    expect(signedIn.user.role).toBe('owner');
    await expect(people.resetLinkFor('nobody@example.com')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('of an admin or an owner is set again by an owner alone', async () => {
    const { people, owner, invited, as } = world();
    const first = await owner();
    const ada = await as(first);
    const admin = await as(await invited(ada, 'admin', 'grace@example.com'));
    await expect(people.resetLink(admin, first.user.id)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(people.resetLink(admin, admin.user)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await people.resetLink(ada, admin.user)).token).toMatch(/^al_/);
  });
});

describe('people', () => {
  it('are listed, read, and say what they are called', async () => {
    const { people, owner, invited, as } = world();
    const ada = await as(await owner());
    const grace = await invited(ada, 'member', 'grace@example.com');
    expect((await people.list()).map((user) => user.email)).toEqual([
      'ada@example.com',
      'grace@example.com',
    ]);
    expect(await people.get(grace.user.id)).toEqual(grace.user);
    expect((await people.updateMe(await as(grace), { displayName: 'Grace' })).displayName).toBe(
      'Grace',
    );
  });

  it('have their role changed, and are disabled, by an admin, but an admin or an owner only by an owner', async () => {
    const { people, owner, invited, as } = world();
    const first = await owner();
    const ada = await as(first);
    const admin = await as(await invited(ada, 'admin', 'grace@example.com'));
    const member = await invited(ada, 'member', 'alan@example.com');

    expect((await people.update(admin, member.user.id, { role: 'viewer' })).role).toBe('viewer');
    // Not up to an admin, not an admin's own kind, and never an owner.
    for (const [target, changes] of [
      [member.user.id, { role: 'admin' }],
      [admin.user, { disabled: true }],
      [first.user.id, { role: 'member' }],
    ] as const) {
      await expect(people.update(admin, target, changes)).rejects.toMatchObject({
        code: 'forbidden',
      });
    }
    expect((await people.update(ada, member.user.id, { role: 'admin' })).role).toBe('admin');
    // What a person is called is no such change.
    expect(
      (await people.update(admin, first.user.id, { displayName: 'The owner' })).displayName,
    ).toBe('The owner');
  });

  it('who are disabled are signed out, cannot sign in, and can be let back', async () => {
    const { people, owner, invited, as } = world();
    const ada = await as(await owner());
    const grace = await invited(ada, 'member', 'grace@example.com');
    const disabled = await people.update(ada, grace.user.id, { disabled: true });
    expect(disabled.disabledAt).toBe(NOW);
    await expect(as(grace)).rejects.toMatchObject({ code: 'unauthenticated' });

    expect((await people.update(ada, grace.user.id, { disabled: false })).disabledAt).toBeNull();
    const signedIn = await people.signIn({
      email: 'grace@example.com',
      password: PASSWORD,
      client: 'cli',
    });
    expect(signedIn.user.id).toBe(grace.user.id);
  });

  it('always include an owner who can sign in, and nobody takes their own way in away', async () => {
    const { people, owner, invited, as } = world();
    const first = await owner();
    const ada = await as(first);
    await expect(people.update(ada, ada.user, { role: 'admin' })).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(people.update(ada, ada.user, { disabled: true })).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(people.remove(ada, ada.user)).rejects.toMatchObject({ code: 'conflict' });

    // With a second owner, the first can be made less by them, and then the second is the last.
    const second = await as(await invited(ada, 'owner', 'grace@example.com'));
    expect((await people.update(second, ada.user, { role: 'member' })).role).toBe('member');
    const viaKey = (await people.resetLinkFor('ada@example.com')).token;
    expect(viaKey).toMatch(/^al_/);
    await expect(
      people.update(Keys.settings, second.user, { disabled: true }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(people.remove(Keys.settings, second.user)).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('are removed with their sessions and their keys, and the keys those made', async () => {
    const { people, keys, owner, invited, as } = world();
    const ada = await as(await owner());
    const grace = await invited(ada, 'member', 'grace@example.com');
    const hers = await keys.create(await as(grace), {
      label: 'hers',
      scope: { type: 'engine' },
      permissions: ['keys:manage', 'actors:read'],
    });
    const child = await keys.create(await keys.authenticate(hers.token), {
      label: 'made by hers',
      scope: { type: 'engine' },
      permissions: ['actors:read'],
    });
    const service = await keys.create(await as(grace), {
      label: 'a service’s',
      scope: { type: 'engine' },
      permissions: ['actors:read'],
      service: true,
    });

    await people.remove(ada, grace.user.id);
    await expect(people.get(grace.user.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(as(grace)).rejects.toMatchObject({ code: 'unauthenticated' });
    for (const gone of [hers, child]) {
      await expect(keys.authenticate(gone.token)).rejects.toMatchObject({
        code: 'unauthenticated',
      });
    }
    // A key that was made as nobody's outlasts whoever made it.
    expect((await keys.authenticate(service.token)).owner).toBeNull();
  });
});

describe('a person’s API key', () => {
  it('does no more than the person may now, and stops when they can no longer sign in', async () => {
    const { people, keys, owner, invited, as } = world();
    const ada = await as(await owner());
    const grace = await invited(ada, 'member', 'grace@example.com');
    const { token } = await keys.create(await as(grace), {
      label: 'hers',
      scope: { type: 'engine' },
      permissions: ['agents:deploy', 'actors:read'],
    });
    expect((await keys.authenticate(token)).permissions).toEqual(['agents:deploy', 'actors:read']);

    await people.update(ada, grace.user.id, { role: 'viewer' });
    expect((await keys.authenticate(token)).permissions).toEqual(['actors:read']);
    await people.update(ada, grace.user.id, { disabled: true });
    await expect(keys.authenticate(token)).rejects.toMatchObject({ code: 'unauthenticated' });
    await people.update(ada, grace.user.id, { disabled: false, role: 'member' });
    expect((await keys.authenticate(token)).permissions).toEqual(['agents:deploy', 'actors:read']);
  });

  it('cannot be used to make more of anyone than its person could', async () => {
    const { people, keys, owner, invited, as } = world();
    const ada = await as(await owner());
    const admin = await invited(ada, 'admin', 'grace@example.com');
    const manage = { scope: { type: 'engine' }, permissions: ['users:manage'] } as const;
    const hers = await keys.create(await as(admin), { label: 'hers', ...manage });
    const nobodys = await keys.create(await as(admin), {
      label: 'a service’s',
      ...manage,
      service: true,
    });
    for (const { token } of [hers, nobodys]) {
      const key = await keys.authenticate(token);
      await expect(people.invite(key, { role: 'owner' })).rejects.toMatchObject({
        code: 'forbidden',
      });
      expect((await people.invite(key, { role: 'member' })).invite.role).toBe('member');
    }
    // The key an engine is started with is its operator's, who can do anything to it anyway.
    expect((await people.invite(Keys.settings, { role: 'owner' })).invite.role).toBe('owner');
  });
});

describe('the audit log', () => {
  it('has what was done to people, by whom, and never a password or a link', async () => {
    const { people, audit, owner, invited, as, actions } = world();
    const first = await owner();
    const ada = await as(first);
    const grace = await invited(ada, 'member', 'grace@example.com');
    await people
      .signIn({ email: 'ada@example.com', password: 'wrong', client: 'cli' })
      .catch(() => {});
    await people.update(ada, grace.user.id, { role: 'viewer' });
    const { token } = await people.resetLink(ada, grace.user.id);
    await people.reset({ token, password: 'a new one, long enough' });
    await people.remove(ada, grace.user.id);
    await people.signOut(ada);

    expect(await actions()).toEqual([
      'user.setup',
      'invite.create',
      'invite.accept',
      'user.sign_in_failed',
      'user.update',
      'user.password_reset_link',
      'user.password_reset',
      'user.delete',
      'user.sign_out',
    ]);
    const { items } = await audit.list({ limit: 100 });
    expect(items.find((event) => event.action === 'user.update')).toMatchObject({
      by: { type: 'user', id: first.user.id },
      target: { type: 'user', id: grace.user.id },
      detail: { role: 'viewer' },
    });
    const written = JSON.stringify(items);
    for (const secret of [PASSWORD, 'a new one, long enough', token, first.token]) {
      expect(written).not.toContain(secret);
    }
  });
});
