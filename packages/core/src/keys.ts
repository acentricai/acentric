// API keys: what a program calls the engine with, and for what.
//
// A key says two things. Its scope is what it reaches: the whole engine, one agent with its
// actors, or one actor. Its permissions are what it may do there. A request is let through
// when its key reaches what the request is about and holds the permission the request takes.
//
// A key that may make keys makes none wider than itself: none that reaches further, may do
// more, or works for longer. So the service that holds a key for an agent can hand a client a
// key for one actor, and nothing else. A key is revoked with every key it made.
//
// A key is `ak_<id>_<secret>`. The secret is shown once, when the key is made, and only its
// hash is kept.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { HOLDABLE, PERMISSIONS, makeId } from '@acentric/protocol';
import type {
  ActorId,
  AgentId,
  Key,
  KeyId,
  Permission,
  Principal,
  PrincipalRef,
  Scope,
  UserId,
} from '@acentric/protocol';

import { EngineError } from './errors.ts';
import type { Store, StoredKey } from './store.ts';

/** The request came with no key, or with one that is not known, was revoked or has expired. */
export class Unauthenticated extends EngineError {
  override readonly name = 'Unauthenticated';
  readonly code = 'unauthenticated';
}

/** The request's key does not reach what it is about, or lacks the permission it takes. */
export class Forbidden extends EngineError {
  override readonly name = 'Forbidden';
  readonly code = 'forbidden';
}

export class KeyNotFound extends EngineError {
  override readonly name = 'KeyNotFound';
  readonly code = 'not_found';
  constructor(id: string) {
    super(`There is no key ${id}`);
  }
}

/** A key that was asked for cannot be: what it was to hold or reach is not something a key can. */
export class InvalidKey extends EngineError {
  override readonly name = 'InvalidKey';
  readonly code = 'invalid_request';
}

/** Who a request with a key is from. */
export type KeyPrincipal = Extract<Principal, { type: 'key' }>;

/** A key to make. */
export type NewKey = {
  readonly label: string;
  readonly scope: Scope;
  readonly permissions: readonly Permission[];
  readonly expiresAt?: number;
  /** A key that is nobody's. It is what a key made by a key always is. */
  readonly service?: boolean;
};

/** What makes or sees keys, as far as the rules go: a key, or a person signed in. */
type Holder = {
  readonly ref: PrincipalRef;
  readonly scope: Scope;
  readonly permissions: readonly Permission[];
  readonly expiresAt: number | null;
  /** The person a key it makes belongs to, unless the key is made as a service's. */
  readonly owner: UserId | null;
  /** The key keys it makes are revoked with. */
  readonly key: KeyId | null;
};

function holderOf(principal: Principal): Holder {
  if (principal.type === 'key') {
    return {
      ref: { type: 'key', id: principal.key },
      scope: principal.scope,
      permissions: principal.permissions,
      expiresAt: principal.expiresAt,
      owner: principal.owner,
      key: principal.key,
    };
  }
  return {
    ref: { type: 'user', id: principal.user },
    scope: { type: 'engine' },
    permissions: principal.permissions,
    expiresAt: null,
    owner: principal.user,
    key: null,
  };
}

const TOKEN = /^ak_([0-9a-z]{26})_([A-Za-z0-9_-]{43})$/;
/** How often at most a key's last use is written down. */
const USED_EVERY_MS = 60_000;

const hashOf = (secret: string): Buffer => createHash('sha256').update(secret).digest();

/**
 * The ID of the key an engine is started with. That key is in no store: it works while the
 * engine is started with it, and no longer.
 */
export const SETTINGS_KEY: KeyId = makeId('key', { now: 0, random: new Uint8Array(10) });

/**
 * Whether a scope reaches an agent, or one of an agent's actors. A key for one actor reaches
 * that actor, and nothing of its agent besides.
 */
export function reaches(
  scope: Scope,
  target: { readonly agent: AgentId; readonly actor?: ActorId },
): boolean {
  if (scope.type === 'engine') return true;
  if (scope.type === 'agent') return scope.agent === target.agent;
  return target.actor !== undefined && scope.actor === target.actor;
}

export class Keys {
  readonly #store: Store;
  readonly #settingsHash: Buffer | undefined;
  readonly #agentOf: (actor: ActorId) => Promise<AgentId | undefined>;
  readonly #clock: () => number;
  readonly #entropy: () => Uint8Array;
  /** When each key's last use was last written down. */
  readonly #touched = new Map<KeyId, number>();

  constructor(options: {
    readonly store: Store;
    /**
     * A key the engine is started with, which may do everything: what its operator keeps
     * where their secrets are kept. 24 characters or more.
     */
    readonly settingsKey?: string;
    /** The agent of an actor, or undefined when there is no such actor. */
    readonly agentOf: (actor: ActorId) => Promise<AgentId | undefined>;
    readonly clock?: () => number;
    readonly entropy?: () => Uint8Array;
  }) {
    const { settingsKey } = options;
    if (settingsKey !== undefined) {
      if (settingsKey.length < 24) {
        throw new Error('The key an engine is started with is 24 characters or more');
      }
      this.#settingsHash = hashOf(settingsKey);
    }
    this.#store = options.store;
    this.#agentOf = options.agentOf;
    this.#clock = options.clock ?? Date.now;
    this.#entropy = options.entropy ?? (() => crypto.getRandomValues(new Uint8Array(10)));
  }

  /** Who the key an engine is started with is. */
  static readonly settings: KeyPrincipal = {
    type: 'key',
    key: SETTINGS_KEY,
    owner: null,
    scope: { type: 'engine' },
    permissions: [...PERMISSIONS],
    expiresAt: null,
  };

  /**
   * Makes the first key of an engine that nothing can call yet: one that was started with no
   * key, and has none. It gives the key, to be shown once, or undefined when there is a way
   * in already.
   */
  async first(): Promise<string | undefined> {
    if (this.#settingsHash !== undefined || (await this.#store.listKeys()).length > 0) {
      return undefined;
    }
    const made = await this.#make(null, { type: 'system' }, null, {
      label: 'The first key, made when the engine first started',
      scope: { type: 'engine' },
      permissions: PERMISSIONS,
      expiresAt: null,
    });
    return made.token;
  }

  /**
   * Who a request is from, by the key it came with. Rejects with `Unauthenticated` when that
   * is no key that works.
   */
  async authenticate(token: string | undefined): Promise<KeyPrincipal> {
    if (token === undefined || token === '') {
      throw new Unauthenticated('The request has no key: send `Authorization: Bearer <key>`');
    }
    if (this.#settingsHash !== undefined && timingSafeEqual(hashOf(token), this.#settingsHash)) {
      return Keys.settings;
    }
    const [, suffix, secret] = TOKEN.exec(token) ?? [];
    const id = suffix === undefined ? undefined : (`key_${suffix}` as KeyId);
    const stored = id === undefined ? undefined : await this.#store.loadKey(id);
    // The same answer whichever part is wrong, so that neither can be found out alone.
    const refused = new Unauthenticated('The key is not known, was revoked, or has expired');
    if (stored === undefined || secret === undefined) throw refused;
    if (!timingSafeEqual(hashOf(secret), Buffer.from(stored.hash, 'hex'))) throw refused;
    const { key } = stored;
    const now = this.#clock();
    if (key.expiresAt !== null && key.expiresAt <= now) throw refused;
    const touched = this.#touched.get(key.id) ?? key.lastUsedAt;
    if (touched === null || now - touched >= USED_EVERY_MS) {
      this.#touched.set(key.id, now);
      // Not waited for: when a key was last used is nothing a request depends on.
      void this.#store.touchKey(key.id, now).catch(() => {});
    }
    return {
      type: 'key',
      key: key.id,
      owner: key.owner,
      scope: key.scope,
      permissions: key.permissions,
      expiresAt: key.expiresAt,
    };
  }

  /**
   * Makes a key, for one that may make keys, and no wider than that one. The key itself is in
   * the answer, and nowhere after it.
   */
  async create(
    by: Principal,
    given: NewKey,
  ): Promise<{ readonly key: Key; readonly token: string }> {
    const maker = holderOf(by);
    if (!maker.permissions.includes('keys:manage')) throw new Forbidden('It may not make keys');
    const permissions = [...new Set(given.permissions)];
    if (permissions.length === 0) throw new InvalidKey('A key holds one permission or more');
    for (const permission of permissions) {
      if (!HOLDABLE[given.scope.type].includes(permission)) {
        throw new InvalidKey(
          `A key for one ${given.scope.type} cannot hold ${permission}: it can hold ${HOLDABLE[given.scope.type].join(', ')}`,
        );
      }
      if (!maker.permissions.includes(permission)) {
        throw new Forbidden(`It does not hold ${permission}, so it cannot give it`);
      }
    }
    if (!(await this.#within(maker.scope, given.scope))) {
      throw new Forbidden('It cannot make a key that reaches what it does not reach itself');
    }
    const now = this.#clock();
    const { expiresAt } = given;
    if (expiresAt !== undefined && expiresAt <= now) {
      throw new InvalidKey('A key expires at a time to come');
    }
    if (maker.expiresAt !== null && expiresAt !== undefined && expiresAt > maker.expiresAt) {
      throw new Forbidden('It cannot make a key that works for longer than it does itself');
    }
    return this.#make(
      maker.key === SETTINGS_KEY ? null : maker.key,
      maker.ref,
      given.service === true ? null : maker.owner,
      {
        label: given.label,
        scope: given.scope,
        permissions,
        // One made by a key that expires, and said nothing of when, expires with it.
        expiresAt: expiresAt ?? maker.expiresAt,
      },
    );
  }

  /** The keys one that may see keys can see: those no wider than itself, oldest first. */
  async list(by: Principal): Promise<Key[]> {
    const viewer = holderOf(by);
    if (!viewer.permissions.includes('keys:manage')) throw new Forbidden('It may not see keys');
    const seen: Key[] = [];
    for (const { key } of await this.#store.listKeys()) {
      if (await this.#within(viewer.scope, key.scope)) seen.push(key);
    }
    return seen;
  }

  /** A key, without its secret, for one that can see it. */
  async get(by: Principal, id: KeyId): Promise<Key> {
    return (await this.#seen(by, id)).key;
  }

  /** Revokes a key and every key it made, however far down. For one that could have made it. */
  async revoke(by: Principal, id: KeyId): Promise<void> {
    await this.#seen(by, id);
    const all = await this.#store.listKeys();
    const going = new Set<KeyId>([id]);
    // Oldest first: a key is always older than what it made.
    for (const stored of all) {
      if (stored.parent !== null && going.has(stored.parent)) going.add(stored.key.id);
    }
    await this.#store.removeKeys([...going]);
    for (const gone of going) this.#touched.delete(gone);
  }

  async #seen(by: Principal, id: KeyId): Promise<StoredKey> {
    const viewer = holderOf(by);
    if (!viewer.permissions.includes('keys:manage')) throw new Forbidden('It may not see keys');
    const stored = await this.#store.loadKey(id);
    // One it does not reach is, to it, not there.
    if (stored === undefined || !(await this.#within(viewer.scope, stored.key.scope))) {
      throw new KeyNotFound(id);
    }
    return stored;
  }

  /** Whether `inner` reaches nothing that `outer` does not. */
  async #within(outer: Scope, inner: Scope): Promise<boolean> {
    if (outer.type === 'engine') return true;
    if (outer.type === 'agent') {
      if (inner.type === 'agent') return inner.agent === outer.agent;
      return inner.type === 'actor' && (await this.#agentOf(inner.actor)) === outer.agent;
    }
    return inner.type === 'actor' && inner.actor === outer.actor;
  }

  async #make(
    parent: KeyId | null,
    createdBy: PrincipalRef,
    owner: UserId | null,
    given: Pick<Key, 'label' | 'scope' | 'expiresAt'> & {
      readonly permissions: readonly Permission[];
    },
  ): Promise<{ readonly key: Key; readonly token: string }> {
    const now = this.#clock();
    const id = makeId('key', { now, random: this.#entropy() });
    const secret = randomBytes(32).toString('base64url');
    const key: Key = {
      id,
      label: given.label,
      owner,
      scope: given.scope,
      permissions: [...given.permissions],
      expiresAt: given.expiresAt,
      createdBy,
      createdAt: now,
      lastUsedAt: null,
    };
    await this.#store.addKey({ key, hash: hashOf(secret).toString('hex'), parent });
    return { key, token: `ak_${id.slice('key_'.length)}_${secret}` };
  }
}
