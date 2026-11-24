// People: who may use an engine by signing in, and what each may do.
//
// A person signs in with their email and a password. The engine sends no email: an email is
// what a person signs in as, and nothing is ever sent to it. So an account is made by a link
// that is used once, which whoever made it passes on themselves. A server with no person yet
// makes the first such link, for its owner. After that an admin makes an invite. A password
// that was lost is set again by a link the same way.
//
// Signed in, a person has a session: a token, of which only the hash is kept. A person may do
// what their role may. Two rules are no permission's: only an owner changes an admin or an
// owner, and an engine always has an owner who can sign in.

import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

import { ROLE_PERMISSIONS, isAtLeast } from '@acentric/protocol';
import type {
  Invite,
  InviteId,
  Principal,
  PrincipalRef,
  Role,
  Session,
  SessionId,
  User,
  UserId,
} from '@acentric/protocol';

import type { Audit } from './audit.ts';
import { Conflict, EngineError } from './errors.ts';
import { IdSource } from './ids.ts';
import { Forbidden, SETTINGS_KEY, Unauthenticated, descendantsOf } from './keys.ts';
import type { Store, StoredLink, StoredUser } from './store.ts';

/** The email and the password are not a person's who can sign in. */
export class InvalidCredentials extends EngineError {
  override readonly name = 'InvalidCredentials';
  readonly code = 'invalid_credentials';
  constructor() {
    super('The email and the password are not a person’s who can sign in');
  }
}

/** A link that was to be used once is not known, was used, was revoked or has expired. */
export class InvalidLink extends EngineError {
  override readonly name = 'InvalidLink';
  readonly code = 'invalid_link';
  constructor() {
    super('The link is not known, was used already, or has expired');
  }
}

/** Signing in as an email failed too many times: it is refused for a while, whatever is given. */
export class TooManyAttempts extends EngineError {
  override readonly name = 'TooManyAttempts';
  readonly code = 'rate_limited';
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(
      `Signing in failed too many times: try again in ${String(Math.ceil(retryAfterMs / 1000))} seconds`,
    );
    this.retryAfterMs = retryAfterMs;
  }
}

export class PersonNotFound extends EngineError {
  override readonly name = 'PersonNotFound';
  readonly code = 'not_found';
  constructor(what: string) {
    super(`There is no ${what}`);
  }
}

/** Who a request from a person signed in is from. */
export type UserPrincipal = Extract<Principal, { type: 'user' }>;

/** A person signed in, with the token their requests are sent with from now on. */
export type SignedIn = {
  readonly user: User;
  readonly session: Session;
  readonly token: string;
};

/** What a session is for, said when it is made. */
export type SessionFor = { readonly client: Session['client']; readonly label?: string };

const DAY = 86_400_000;
/** How long a session lasts from when it was last used. */
const SESSION_MS = { dashboard: 30 * DAY, cli: 90 * DAY } as const;
/** How often at most a session's last use is written down. */
const USED_EVERY_MS = 60_000;
const INVITE_MS = 7 * DAY;
const RESET_MS = DAY;

/** How many times signing in as an email may fail before it is refused for a while. */
const ATTEMPTS = 5;
const FIRST_WAIT_MS = 30_000;
const LONGEST_WAIT_MS = 15 * 60_000;

const TOKEN = /^(as|al)_([0-9a-z]{26})_([A-Za-z0-9_-]{43})$/;

const hashOf = (secret: string): string => createHash('sha256').update(secret).digest('hex');
const emailOf = (given: string): string => given.trim().toLowerCase();

/** The parts of a token of a kind: the ID it names and its secret. */
function partsOf(kind: 'as' | 'al', token: string): { id: string; secret: string } | undefined {
  const [, prefix, id, secret] = TOKEN.exec(token) ?? [];
  if (prefix !== kind || id === undefined || secret === undefined) return undefined;
  return { id, secret };
}

const same = (a: string, b: string): boolean => {
  const [left, right] = [Buffer.from(a, 'hex'), Buffer.from(b, 'hex')];
  return left.length === right.length && timingSafeEqual(left, right);
};

export class People {
  readonly #store: Store;
  readonly #audit: Audit | undefined;
  readonly #clock: () => number;
  readonly #ids: IdSource;
  readonly #cost: number;
  /** How many times signing in as each email failed, and until when it is refused. */
  readonly #failed = new Map<string, { count: number; until: number }>();
  readonly #keptFailures: number;
  /** When each session's last use was last written down. */
  readonly #touched = new Map<SessionId, number>();

  constructor(options: {
    readonly store: Store;
    readonly audit?: Audit;
    readonly clock?: () => number;
    readonly entropy?: () => Uint8Array;
    /**
     * How hard a password's hash is to make: scrypt's N, a power of two. 32,768 without it,
     * which takes a moment on purpose. Tests ask for less.
     */
    readonly passwordCost?: number;
    /**
     * How many emails' failed sign-ins are kept, to refuse one that failed too often: 10,000
     * without it. Past it, those that are not refused now go first, the oldest first.
     */
    readonly keptFailures?: number;
  }) {
    this.#store = options.store;
    this.#audit = options.audit;
    this.#clock = options.clock ?? Date.now;
    this.#ids = new IdSource(options.entropy ?? (() => crypto.getRandomValues(new Uint8Array(10))));
    this.#cost = options.passwordCost ?? 32_768;
    this.#keptFailures = options.keptFailures ?? 10_000;
  }

  /** How many emails' failed sign-ins are kept now. */
  get failing(): number {
    return this.#failed.size;
  }

  // The first person

  /**
   * For an engine with no person yet: a new link that makes its owner, in place of any it
   * made before. Undefined when there is a person already.
   */
  async setupLink(): Promise<string | undefined> {
    if ((await this.#store.listUsers()).length > 0) return undefined;
    for (const old of await this.#store.listLinks('setup')) await this.#store.removeLink(old.id);
    const { token } = await this.#link('setup', { type: 'system' }, INVITE_MS, { role: 'owner' });
    return token;
  }

  /** Makes the owner of an engine that has no person yet, by its setup link, and signs them in. */
  async setup(given: { readonly token: string } & NewPerson & SessionFor): Promise<SignedIn> {
    const signedIn = await this.#join('setup', given);
    await this.#audit?.record({
      by: { type: 'user', id: signedIn.user.id },
      action: 'user.setup',
      target: { type: 'user', id: signedIn.user.id },
    });
    return signedIn;
  }

  // Signing in

  /**
   * Keeps no more failed sign-ins than the number: anyone may try any email, and each is kept.
   * Those that are not refused now go first, the oldest first, so that many emails tried at
   * random do not make one being refused tried again.
   */
  #forgetPast(now: number): void {
    if (this.#failed.size <= this.#keptFailures) return;
    for (const [email, failed] of this.#failed) {
      if (this.#failed.size <= this.#keptFailures) return;
      if (failed.until <= now) this.#failed.delete(email);
    }
    for (const email of this.#failed.keys()) {
      if (this.#failed.size <= this.#keptFailures) return;
      this.#failed.delete(email);
    }
  }

  async signIn(
    given: {
      readonly email: string;
      readonly password: string;
    } & SessionFor,
  ): Promise<SignedIn> {
    const email = emailOf(given.email);
    const now = this.#clock();
    const failed = this.#failed.get(email);
    if (failed !== undefined && failed.until > now) throw new TooManyAttempts(failed.until - now);

    const stored = await this.#store.findUser(email);
    // A hash is checked whether or not there is such a person, so that the time it takes
    // does not say which.
    const right = await this.#verify(given.password, stored?.password);
    if (stored === undefined || !right || stored.user.disabledAt !== null) {
      const count = (failed?.count ?? 0) + 1;
      const wait =
        count < ATTEMPTS ? 0 : Math.min(FIRST_WAIT_MS * 2 ** (count - ATTEMPTS), LONGEST_WAIT_MS);
      this.#failed.delete(email);
      this.#failed.set(email, { count, until: now + wait });
      this.#forgetPast(now);
      await this.#audit?.record({
        by: { type: 'system' },
        action: 'user.sign_in_failed',
        detail: { email },
      });
      throw new InvalidCredentials();
    }
    this.#failed.delete(email);
    const signedIn = await this.#session(stored.user, given);
    await this.#audit?.record({
      by: { type: 'user', id: stored.user.id },
      action: 'user.sign_in',
      detail: { client: given.client },
    });
    return signedIn;
  }

  /**
   * Who a request is from, by the session token it came with. Rejects with `Unauthenticated`
   * when that is no session that is still good, or its person can no longer sign in.
   */
  async authenticate(token: string): Promise<UserPrincipal> {
    const refused = new Unauthenticated('The session is not known, was ended, or has expired');
    const parts = partsOf('as', token);
    if (parts === undefined) throw refused;
    const id = `ses_${parts.id}` as SessionId;
    const stored = await this.#store.loadSession(id);
    if (stored === undefined || !same(hashOf(parts.secret), stored.hash)) throw refused;
    const { session } = stored;
    const now = this.#clock();
    if (session.expiresAt <= now) throw refused;
    const person = await this.#store.loadUser(session.user);
    if (person === undefined || person.user.disabledAt !== null) throw refused;

    const touched = this.#touched.get(id) ?? session.lastUsedAt;
    if (touched === null || now - touched >= USED_EVERY_MS) {
      this.#touched.set(id, now);
      // Not waited for: a session lasts from when it was last used, to the minute.
      void this.#store.touchSession(id, now, now + SESSION_MS[session.client]).catch(() => {});
    }
    const { user } = person;
    return {
      type: 'user',
      user: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      permissions: [...ROLE_PERMISSIONS[user.role]],
      session: id,
    };
  }

  /** Ends a session. */
  async signOut(principal: UserPrincipal): Promise<void> {
    await this.#store.removeSession(principal.session);
    this.#touched.delete(principal.session);
    await this.#audit?.record({
      by: { type: 'user', id: principal.user },
      action: 'user.sign_out',
    });
  }

  /** Where a person is signed in. */
  sessions(user: UserId): Promise<Session[]> {
    return this.#store.listSessions(user);
  }

  /** Ends one of a person's own sessions. To them, another's is not there. */
  async endSession(principal: UserPrincipal, id: SessionId): Promise<void> {
    const stored = await this.#store.loadSession(id);
    if (stored === undefined || stored.session.user !== principal.user) {
      throw new PersonNotFound(`session ${id}`);
    }
    await this.#store.removeSession(id);
    this.#touched.delete(id);
    await this.#audit?.record({
      by: { type: 'user', id: principal.user },
      action: 'session.revoke',
      target: { type: 'session', id },
    });
  }

  // Invites

  /**
   * Makes an invite: a link that makes one account with a role. Only an owner invites an
   * admin or an owner. The link's token is in the answer, and nowhere after.
   */
  async invite(
    by: Principal,
    given: { readonly role: Role; readonly note?: string },
  ): Promise<{ readonly invite: Invite; readonly token: string }> {
    await this.#mayGive(by, given.role);
    const { link, token } = await this.#link('invite', refOf(by), INVITE_MS, {
      role: given.role,
      note: given.note ?? null,
    });
    await this.#audit?.record({
      by: refOf(by),
      action: 'invite.create',
      target: { type: 'invite', id: link.id },
      detail: { role: given.role },
    });
    return { invite: inviteOf(link), token };
  }

  /** The invites that can still be used, in the order they were made. */
  async invites(): Promise<Invite[]> {
    const now = this.#clock();
    return (await this.#store.listLinks('invite'))
      .filter((link) => link.expiresAt > now)
      .map(inviteOf);
  }

  /** Takes an invite back: its link no longer works. */
  async revokeInvite(by: Principal, id: InviteId): Promise<void> {
    const link = await this.#store.loadLink(id);
    if (link?.kind !== 'invite' || !(await this.#store.removeLink(id))) {
      throw new PersonNotFound(`invite ${id}`);
    }
    await this.#audit?.record({
      by: refOf(by),
      action: 'invite.revoke',
      target: { type: 'invite', id },
    });
  }

  /** Makes the account an invite is for, and signs its person in. */
  async accept(given: { readonly token: string } & NewPerson & SessionFor): Promise<SignedIn> {
    const signedIn = await this.#join('invite', given);
    await this.#audit?.record({
      by: { type: 'user', id: signedIn.user.id },
      action: 'invite.accept',
      target: { type: 'user', id: signedIn.user.id },
      detail: { role: signedIn.user.role },
    });
    return signedIn;
  }

  // Passwords

  /** A person's own change of their password. Everywhere else they are signed in is signed out. */
  async changePassword(
    principal: UserPrincipal,
    given: { readonly current: string; readonly password: string },
  ): Promise<void> {
    const stored = await this.#store.loadUser(principal.user);
    if (stored === undefined || !(await this.#verify(given.current, stored.password))) {
      throw new InvalidCredentials();
    }
    await this.#store.saveUser({ ...stored, password: await this.#hash(given.password) });
    await this.#store.removeSessions(principal.user, principal.session);
    await this.#audit?.record({
      by: { type: 'user', id: principal.user },
      action: 'user.password_change',
    });
  }

  /**
   * Makes a link that sets a person's password again, for one who lost theirs. Only an owner
   * makes one for an admin or an owner.
   */
  async resetLink(
    by: Principal,
    user: UserId,
  ): Promise<{ readonly token: string; readonly expiresAt: number }> {
    const stored = await this.#person(user);
    await this.#mayChange(by, stored.user.role);
    return this.#reset(refOf(by), stored.user);
  }

  /**
   * The same link, made by whoever runs the server, for a person by what they sign in as: the
   * way back in for an owner who is locked out. It is asked for on the server itself.
   */
  async resetLinkFor(
    email: string,
  ): Promise<{ readonly token: string; readonly expiresAt: number }> {
    const stored = await this.#store.findUser(emailOf(email));
    if (stored === undefined) throw new PersonNotFound(`person who signs in as ${email}`);
    return this.#reset({ type: 'system' }, stored.user);
  }

  /** Sets a password again by a reset link, and signs its person out everywhere. */
  async reset(given: { readonly token: string; readonly password: string }): Promise<void> {
    const link = await this.#usable('reset', given.token);
    const user = link.user as UserId;
    const password = await this.#hash(given.password);
    if ((await this.#store.redeemLink(link.id, { setPassword: { user, password } })) === 'gone') {
      throw new InvalidLink();
    }
    await this.#store.removeSessions(user);
    this.#failed.delete((await this.#store.loadUser(user))?.user.email ?? '');
    await this.#audit?.record({
      by: { type: 'user', id: user },
      action: 'user.password_reset',
      target: { type: 'user', id: user },
    });
  }

  // People

  /** Everyone, in the order they were made. */
  list(): Promise<User[]> {
    return this.#store.listUsers();
  }

  async get(id: UserId): Promise<User> {
    return (await this.#person(id)).user;
  }

  /** What a person changes of themselves. */
  async updateMe(
    principal: UserPrincipal,
    changes: { readonly displayName: string | null },
  ): Promise<User> {
    const stored = await this.#person(principal.user);
    const user = { ...stored.user, displayName: changes.displayName };
    await this.#store.saveUser({ ...stored, user });
    return user;
  }

  /**
   * Changes what a person is called, their role, or whether they can sign in. Only an owner
   * changes an admin or an owner, or makes one. Nobody takes their own way in away, and the
   * last owner who can sign in stays one.
   */
  async update(
    by: Principal,
    id: UserId,
    changes: {
      readonly displayName?: string | null;
      readonly role?: Role;
      readonly disabled?: boolean;
    },
  ): Promise<User> {
    const stored = await this.#person(id);
    const before = stored.user;
    const role = changes.role ?? before.role;
    const disabled = changes.disabled ?? before.disabledAt !== null;
    const lessens = role !== before.role || (disabled && before.disabledAt === null);
    if (role !== before.role || changes.disabled !== undefined) {
      await this.#mayChange(by, before.role);
      await this.#mayGive(by, role);
    }
    if (lessens && by.type === 'user' && by.user === id) {
      throw new Conflict('Nobody changes their own role, or disables themselves');
    }
    if (lessens && before.role === 'owner' && (role !== 'owner' || disabled)) {
      await this.#anotherOwner(id);
    }
    const user: User = {
      ...before,
      ...(changes.displayName === undefined ? {} : { displayName: changes.displayName }),
      role,
      disabledAt: disabled ? (before.disabledAt ?? this.#clock()) : null,
    };
    await this.#store.saveUser({ ...stored, user });
    // One who can no longer sign in is signed out. Their keys stop with them (see `Keys`).
    if (disabled) await this.#store.removeSessions(id);
    await this.#audit?.record({
      by: refOf(by),
      action: 'user.update',
      target: { type: 'user', id },
      detail: {
        ...(role === before.role ? {} : { role }),
        ...(changes.disabled === undefined ? {} : { disabled }),
      },
    });
    return user;
  }

  /** Removes a person, with their sessions and the keys that were theirs. */
  async remove(by: Principal, id: UserId): Promise<void> {
    const stored = await this.#person(id);
    await this.#mayChange(by, stored.user.role);
    if (by.type === 'user' && by.user === id) throw new Conflict('Nobody removes themselves');
    if (stored.user.role === 'owner') await this.#anotherOwner(id);
    await this.#store.removeUser(id);
    const keys = await this.#store.listKeys();
    const theirs = keys.filter((one) => one.key.owner === id).map((one) => one.key.id);
    await this.#store.removeKeys(descendantsOf(keys, theirs));
    await this.#audit?.record({
      by: refOf(by),
      action: 'user.delete',
      target: { type: 'user', id },
      detail: { email: stored.user.email },
    });
  }

  /** A person's role, and whether they can sign in: what their keys are held to. */
  async holder(id: UserId): Promise<{ role: Role; disabled: boolean } | undefined> {
    const stored = await this.#store.loadUser(id);
    if (stored === undefined) return undefined;
    return { role: stored.user.role, disabled: stored.user.disabledAt !== null };
  }

  // Inside

  async #person(id: UserId): Promise<StoredUser> {
    const stored = await this.#store.loadUser(id);
    if (stored === undefined) throw new PersonNotFound(`person ${id}`);
    return stored;
  }

  /**
   * How much one who asks may do to people: a person's own role, a person's key that person's
   * role, the key an engine was started with an owner's, and a key that is nobody's an
   * admin's. So no key makes more of anyone than whoever made the key could.
   */
  async #rank(by: Principal): Promise<Role> {
    if (by.type === 'user') return by.role;
    if (by.key === SETTINGS_KEY) return 'owner';
    if (by.owner === null) return 'admin';
    return (await this.holder(by.owner))?.role ?? 'viewer';
  }

  /** Only an owner changes an admin or an owner. */
  async #mayChange(by: Principal, role: Role): Promise<void> {
    if (isAtLeast(role, 'admin') && (await this.#rank(by)) !== 'owner') {
      throw new Forbidden('Only an owner changes an admin or an owner');
    }
  }

  /** Only an owner makes an admin or an owner. */
  async #mayGive(by: Principal, role: Role): Promise<void> {
    if (isAtLeast(role, 'admin') && (await this.#rank(by)) !== 'owner') {
      throw new Forbidden('Only an owner makes an admin or an owner');
    }
  }

  /** Refuses what would leave an engine with no owner who can sign in. */
  async #anotherOwner(but: UserId): Promise<void> {
    const others = (await this.#store.listUsers()).filter(
      (user) => user.id !== but && user.role === 'owner' && user.disabledAt === null,
    );
    if (others.length === 0) {
      throw new Conflict('An engine always has an owner who can sign in: this is the last one');
    }
  }

  async #link(
    kind: StoredLink['kind'],
    createdBy: PrincipalRef,
    lastsMs: number,
    more: Partial<Pick<StoredLink, 'role' | 'user' | 'note'>>,
  ): Promise<{ readonly link: StoredLink; readonly token: string }> {
    const now = this.#clock();
    const id = this.#ids.make('invite', now);
    const secret = randomBytes(32).toString('base64url');
    const link: StoredLink = {
      id,
      kind,
      hash: hashOf(secret),
      role: more.role ?? null,
      user: more.user ?? null,
      note: more.note ?? null,
      createdBy,
      createdAt: now,
      expiresAt: now + lastsMs,
    };
    await this.#store.addLink(link);
    return { link, token: `al_${id.slice('inv_'.length)}_${secret}` };
  }

  /** The link a token is of, when it is of this kind and can still be used. */
  async #usable(kind: StoredLink['kind'], token: string): Promise<StoredLink> {
    const parts = partsOf('al', token);
    const link =
      parts === undefined ? undefined : await this.#store.loadLink(`inv_${parts.id}` as InviteId);
    if (
      parts === undefined ||
      link === undefined ||
      link.kind !== kind ||
      !same(hashOf(parts.secret), link.hash) ||
      link.expiresAt <= this.#clock()
    ) {
      throw new InvalidLink();
    }
    return link;
  }

  /** Makes the account a setup link or an invite is for, and signs its person in. */
  async #join(
    kind: 'setup' | 'invite',
    given: { readonly token: string } & NewPerson & SessionFor,
  ): Promise<SignedIn> {
    const link = await this.#usable(kind, given.token);
    const now = this.#clock();
    const user: User = {
      id: this.#ids.make('user', now),
      email: emailOf(given.email),
      displayName: given.displayName ?? null,
      role: link.role ?? 'member',
      createdAt: now,
      disabledAt: null,
    };
    const addUser = { user, password: await this.#hash(given.password) };
    if ((await this.#store.redeemLink(link.id, { addUser })) === 'gone') throw new InvalidLink();
    return this.#session(user, given);
  }

  async #reset(
    by: PrincipalRef,
    user: User,
  ): Promise<{ readonly token: string; readonly expiresAt: number }> {
    const { link, token } = await this.#link('reset', by, RESET_MS, { user: user.id });
    await this.#audit?.record({
      by,
      action: 'user.password_reset_link',
      target: { type: 'user', id: user.id },
    });
    return { token, expiresAt: link.expiresAt };
  }

  async #session(user: User, given: SessionFor): Promise<SignedIn> {
    const now = this.#clock();
    const id = this.#ids.make('session', now);
    const secret = randomBytes(32).toString('base64url');
    const session: Session = {
      id,
      user: user.id,
      client: given.client,
      label: given.label ?? null,
      createdAt: now,
      lastUsedAt: null,
      expiresAt: now + SESSION_MS[given.client],
    };
    await this.#store.addSession({ session, hash: hashOf(secret) });
    return { user, session, token: `as_${id.slice('ses_'.length)}_${secret}` };
  }

  /** A password's hash, with what it was made by: `scrypt$N$r$p$salt$hash`. */
  async #hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const hash = await derive(password, salt, this.#cost);
    return `scrypt$${String(this.#cost)}$8$1$${salt.toString('base64')}$${hash.toString('base64')}`;
  }

  /**
   * Whether a password is the one a hash was made of. With no hash, the work of checking one
   * is done all the same, and the answer is no.
   */
  async #verify(password: string, stored: string | undefined): Promise<boolean> {
    const [scheme, cost, , , salt, hash] = (stored ?? '').split('$');
    if (scheme !== 'scrypt' || salt === undefined || hash === undefined) {
      await derive(password, Buffer.alloc(16), this.#cost);
      return false;
    }
    const expected = Buffer.from(hash, 'base64');
    const given = await derive(password, Buffer.from(salt, 'base64'), Number(cost));
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}

/** A person to make. */
type NewPerson = {
  readonly email: string;
  readonly password: string;
  readonly displayName?: string;
};

const refOf = (principal: Principal): PrincipalRef =>
  principal.type === 'user'
    ? { type: 'user', id: principal.user }
    : { type: 'key', id: principal.key };

const inviteOf = (link: StoredLink): Invite => ({
  id: link.id,
  role: link.role ?? 'member',
  note: link.note,
  createdBy: link.createdBy,
  createdAt: link.createdAt,
  expiresAt: link.expiresAt,
});

function derive(password: string, salt: Buffer, cost: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      32,
      { N: cost, r: 8, p: 1, maxmem: 256 * cost * 8 },
      (error, key) => {
        if (error === null) resolve(key);
        else reject(error);
      },
    );
  });
}
