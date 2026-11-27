// Model accounts: what the calls of a provider's models are made with.
//
// An account is a key of a provider's, kept sealed. There can be several for a provider, and
// one of them is that provider's default. An agent is of a provider, not of an account: each of
// its actors is given an account of that provider when it is created, the one asked for or the
// provider's default, and its calls are made with it for as long as it is. An agent's own
// secrets never hold a model key.
//
// A key is checked with its provider when it is added or replaced: an account that is kept is
// one its provider takes. Nothing gives a key back.
//
// An account of a provider that is signed in to, such as ChatGPT, has a token in place of a key
// (see `sign-ins.ts`). The token lasts a while, and is renewed with what the sign-in left before
// it stops being taken. When the provider says the sign-in has ended, the account says why, and
// its calls fail until it is signed in again.

import { ModelFailure } from '@acentric/ai';
import type { Credential, ModelRunner, Provider, Providers, SignedIn } from '@acentric/ai';
import type { Account, AccountId, Actor, PrincipalRef } from '@acentric/protocol';

import type { Audit } from './audit.ts';
import { Conflict, EngineError } from './errors.ts';
import { IdSource } from './ids.ts';
import { sealedFor } from './secrets.ts';
import type { Secrets } from './secrets.ts';
import type { Store, StoredAccount } from './store.ts';

export class AccountNotFound extends EngineError {
  override readonly name = 'AccountNotFound';
  readonly code = 'not_found';
  constructor(id: string) {
    super(`There is no model account ${id}`);
  }
}

/** An account that was asked for cannot be: its provider is not one, or will not take its key. */
export class InvalidAccount extends EngineError {
  override readonly name = 'InvalidAccount';
  readonly code = 'invalid_request';
}

/** The provider could not be asked whether it takes a key. The same request may work later. */
export class ProviderUnreachable extends EngineError {
  override readonly name = 'ProviderUnreachable';
  readonly code = 'provider_failed';
}

/** How long before its token stops being taken a signed-in account's token is renewed. */
const RENEW_BEFORE_MS = 5 * 60 * 1000;

/** What an agent's model calls are made with. */
export type Access = {
  /** The account. Null for calls that no account says anything of. */
  readonly account: AccountId | null;
  readonly runner: ModelRunner;
};

export class Accounts {
  readonly #store: Store;
  readonly #secrets: Secrets;
  readonly #providers: Providers;
  readonly #audit: Audit | undefined;
  readonly #clock: () => number;
  readonly #ids: IdSource;
  readonly #fetch: typeof fetch | undefined;
  /** The runner of each account, made from its credential as it was last sealed. */
  readonly #runners = new Map<
    AccountId,
    { readonly sealed: string; readonly runner: ModelRunner }
  >();
  /** The runner of each signed-in account: it reads the account's token for each call. */
  readonly #signedIn = new Map<AccountId, ModelRunner>();
  /**
   * What is being written of each account, so that one write waits for the other. A renewed
   * token replaces one the provider will not take again: a write of the account as it was
   * before would put that one back.
   */
  readonly #writing = new Map<AccountId, Promise<unknown>>();

  constructor(options: {
    readonly store: Store;
    /** What seals a credential. Without a key of its own, no account can be kept. */
    readonly secrets: Secrets;
    readonly providers: Providers;
    readonly audit?: Audit;
    readonly clock?: () => number;
    readonly entropy?: () => Uint8Array;
    /** In place of the world's `fetch`, for the calls made with an account. */
    readonly fetch?: typeof fetch;
  }) {
    this.#store = options.store;
    this.#secrets = options.secrets;
    this.#providers = options.providers;
    this.#audit = options.audit;
    this.#clock = options.clock ?? Date.now;
    this.#ids = new IdSource(options.entropy ?? (() => crypto.getRandomValues(new Uint8Array(10))));
    this.#fetch = options.fetch;
  }

  /**
   * Adds an account, once its provider has taken its key. The first account of a provider is
   * that provider's default, and so is one that is added as it.
   */
  async add(
    by: PrincipalRef,
    given: {
      readonly provider: string;
      readonly name: string;
      readonly apiKey: string;
      readonly default?: boolean;
    },
  ): Promise<Account> {
    const credential: Credential = { type: 'api_key', apiKey: given.apiKey.trim() };
    await this.#check(given.provider, credential);
    return this.#insert(by, given, credential);
  }

  /** Adds an account that was made by signing in at its provider (see `sign-ins.ts`). */
  async addSignedIn(
    by: PrincipalRef,
    given: { readonly provider: string; readonly name: string; readonly default?: boolean },
    signedIn: SignedIn,
  ): Promise<Account> {
    return this.#insert(by, given, signedIn.credential, { email: signedIn.email });
  }

  /**
   * Signs an account in again: its calls are made with this sign-in from now on, and one that
   * had ended holds again.
   */
  async signInAgain(by: PrincipalRef, id: AccountId, signedIn: SignedIn): Promise<Account> {
    return this.#locked(id, async () => {
      const before = await this.#stored(id);
      const stored: StoredAccount = {
        account: { ...before.account, signIn: { email: signedIn.email } },
        sealed: this.#seal(id, signedIn.credential),
      };
      await this.#store.saveAccount(stored);
      this.#runners.delete(id);
      await this.#audit?.record({
        by,
        action: 'account.update',
        target: { type: 'account', id },
        detail: { signIn: 'again' },
      });
      return this.#shown(stored);
    });
  }

  /**
   * The provider of an account made by signing in, and what it was signed in with: what
   * signing it in again starts from. Throws when it is an account with a key.
   */
  async signedInWith(id: AccountId): Promise<{ provider: Provider; credential: Credential }> {
    const stored = await this.#stored(id);
    const provider = this.#providers.has(stored.account.provider)
      ? this.#providers.get(stored.account.provider)
      : undefined;
    if (provider?.signIn === undefined || stored.account.credential !== 'access_token') {
      throw new InvalidAccount(
        `The account ${stored.account.name} is not signed in to: its key is replaced instead`,
      );
    }
    return { provider, credential: this.#open(stored) };
  }

  async #insert(
    by: PrincipalRef,
    given: { readonly provider: string; readonly name: string; readonly default?: boolean },
    credential: Credential,
    signIn?: { readonly email: string | null },
  ): Promise<Account> {
    const now = this.#clock();
    const id = this.#ids.make('account', now);
    const others = (await this.#store.listAccounts()).filter(
      ({ account }) => account.provider === given.provider,
    );
    const isDefault = given.default === true || others.length === 0;
    const stored: StoredAccount = {
      account: {
        id,
        provider: given.provider,
        name: given.name,
        credential: credential.type,
        ...(signIn === undefined ? {} : { signIn }),
        default: isDefault,
        owner: null,
        createdBy: by,
        createdAt: now,
      },
      sealed: this.#seal(id, credential),
    };
    // The store makes it the only default of its provider, in the same write.
    await this.#store.addAccount(stored);
    await this.#audit?.record({
      by,
      action: 'account.create',
      target: { type: 'account', id },
      detail: { provider: given.provider, name: given.name },
    });
    return this.#shown(stored);
  }

  /** Every account, in the order they were made. Never their keys. */
  async list(): Promise<Account[]> {
    return Promise.all((await this.#store.listAccounts()).map((stored) => this.#shown(stored)));
  }

  async get(id: AccountId): Promise<Account> {
    return this.#shown(await this.#stored(id));
  }

  /**
   * Changes an account's name or key, or makes it its provider's default. A new key is
   * checked with the provider first.
   */
  async update(
    by: PrincipalRef,
    id: AccountId,
    changes: { readonly name?: string; readonly apiKey?: string; readonly default?: true },
  ): Promise<Account> {
    return this.#locked(id, () => this.#update(by, id, changes));
  }

  async #update(
    by: PrincipalRef,
    id: AccountId,
    changes: { readonly name?: string; readonly apiKey?: string; readonly default?: true },
  ): Promise<Account> {
    const before = await this.#stored(id);
    let { sealed } = before;
    if (changes.apiKey !== undefined) {
      const credential: Credential = { type: 'api_key', apiKey: changes.apiKey.trim() };
      await this.#check(before.account.provider, credential);
      sealed = this.#seal(id, credential);
    }
    const stored: StoredAccount = {
      account: {
        ...before.account,
        ...(changes.name === undefined ? {} : { name: changes.name }),
        ...(changes.apiKey === undefined ? {} : { credential: 'api_key' as const }),
        default: before.account.default || changes.default === true,
      },
      sealed,
    };
    // The store makes it the only default of its provider, in the same write.
    await this.#store.saveAccount(stored);
    await this.#audit?.record({
      by,
      action: 'account.update',
      target: { type: 'account', id },
      detail: {
        ...(changes.name === undefined ? {} : { name: changes.name }),
        ...(changes.apiKey === undefined ? {} : { key: 'replaced' }),
        ...(changes.default === undefined ? {} : { default: true }),
      },
    });
    return this.#shown(stored);
  }

  /**
   * Removes an account that no actor that is not archived was given. An archived one that was
   * keeps its ID, and uses its provider's default if it is unarchived. When it was its
   * provider's default, the oldest of that provider's other accounts is the default from then on.
   */
  async remove(by: PrincipalRef, id: AccountId): Promise<void> {
    const stored = await this.#locked(id, async () => {
      const found = await this.#stored(id);
      const actors = await this.#store.actorsGiven(id);
      if (actors > 0) {
        throw new Conflict(
          `${String(actors)} ${actors === 1 ? 'actor is' : 'actors are'} given this account: archive or delete ${actors === 1 ? 'it' : 'them'} first`,
        );
      }
      await this.#store.removeAccount(id);
      this.#runners.delete(id);
      this.#signedIn.delete(id);
      return found;
    });
    // A sign-in is ended at its provider too, so that what it left stops working there. The
    // account goes all the same when the provider cannot be asked.
    const ended = await this.#end(stored);
    if (stored.account.default) {
      const [next] = (await this.#store.listAccounts()).filter(
        ({ account }) => account.provider === stored.account.provider,
      );
      if (next !== undefined) {
        await this.#locked(next.account.id, async () => {
          const now = await this.#store.loadAccount(next.account.id);
          if (now === undefined) return;
          await this.#store.saveAccount({ ...now, account: { ...now.account, default: true } });
        });
      }
    }
    await this.#audit?.record({
      by,
      action: 'account.delete',
      target: { type: 'account', id },
      detail: {
        provider: stored.account.provider,
        name: stored.account.name,
        ...(ended === undefined ? {} : { signInEnded: ended }),
      },
    });
  }

  /**
   * Ends an account's sign-in at its provider. Whether the provider said it has; undefined for
   * an account that is not signed in to.
   */
  async #end(stored: StoredAccount): Promise<boolean | undefined> {
    const { provider } = stored.account;
    const flow = this.#providers.has(provider) ? this.#providers.get(provider).signIn : undefined;
    if (flow === undefined || stored.account.credential !== 'access_token') return undefined;
    try {
      await flow.end(this.#open(stored), this.#signInSettings());
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The account an actor of an agent of `provider` is to be given when it is created: the one
   * asked for, which must be of that provider, or else the provider's default. Throws, with
   * what to do about it, when the one asked for is none or another provider's, or the
   * provider has no account at all.
   */
  async choose(provider: string, wanted?: AccountId): Promise<AccountId> {
    const label = this.#providers.has(provider) ? this.#providers.get(provider).label : provider;
    if (wanted !== undefined) {
      const stored = await this.#store.loadAccount(wanted);
      if (stored === undefined) throw new InvalidAccount(`There is no model account ${wanted}`);
      if (stored.account.provider !== provider) {
        throw new InvalidAccount(
          `The account ${stored.account.name} is of ${stored.account.provider}, and the agent of ${provider}`,
        );
      }
      return stored.account.id;
    }
    const fallback = await this.#defaultOf(provider);
    if (fallback === undefined) {
      throw new Conflict(
        `There is no model account for ${label}: add one before creating an actor`,
      );
    }
    return fallback.account.id;
  }

  /**
   * What an actor's model calls are made with: the account it was given, and a runner made with
   * that account's credential. One that has none, made before actors were given accounts, or
   * whose account was removed while it was archived, uses its provider's default. Throws, with
   * what to do about it, when there is no account.
   */
  async access(actor: Actor, provider: string): Promise<Access> {
    const of = this.#providers.get(provider);
    const stored =
      (actor.account === null ? undefined : await this.#store.loadAccount(actor.account)) ??
      (await this.#defaultOf(provider));
    if (stored === undefined) {
      throw new Error(
        `There is no model account for ${of.label}: add one before its models are called`,
      );
    }
    const { id } = stored.account;
    if (of.signIn !== undefined && stored.account.credential === 'access_token') {
      let runner = this.#signedIn.get(id);
      if (runner === undefined) {
        runner = this.#signedInRunner(id, of);
        this.#signedIn.set(id, runner);
      }
      return { account: id, runner };
    }
    let made = this.#runners.get(id);
    if (made?.sealed !== stored.sealed) {
      const credential = this.#open(stored);
      const runner = of.runner({
        credential,
        ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
      });
      made = { sealed: stored.sealed, runner };
      this.#runners.set(id, made);
    }
    return { account: id, runner: made.runner };
  }

  /**
   * The runner of an account that was signed in to. Each call is made with the account's token
   * as it is then, renewed first when it is about to stop being taken. A call the provider
   * refuses for its credential is made once more with a token renewed for it: the provider may
   * have stopped taking the one it gave before it said it would.
   */
  #signedInRunner(id: AccountId, provider: Provider): ModelRunner {
    const runnerOf = (credential: Credential): ModelRunner =>
      provider.runner({
        credential,
        ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
      });
    return {
      run: async (step, signal) => {
        const { credential, renewed } = await this.#token(id, provider, false);
        try {
          return await runnerOf(credential).run(step, signal);
        } catch (error) {
          if (!(error instanceof ModelFailure) || error.kind !== 'auth' || renewed) throw error;
          const again = await this.#token(id, provider, true);
          return runnerOf(again.credential).run(step, signal);
        }
      },
    };
  }

  /**
   * A signed-in account's credential, renewed when it is about to stop being taken, or when
   * `force` says. `renewed` says whether it was renewed for this.
   */
  async #token(
    id: AccountId,
    provider: Provider,
    force: boolean,
  ): Promise<{ credential: Credential; renewed: boolean }> {
    const stored = await this.#store.loadAccount(id);
    if (stored === undefined) throw new AccountNotFound(id);
    const credential = this.#open(stored);
    const lasts =
      credential.type === 'access_token' && credential.expiresAt !== undefined
        ? credential.expiresAt - this.#clock()
        : Infinity;
    if (stored.account.signIn?.signedOut !== undefined) {
      throw new ModelFailure(
        `${stored.account.signIn.signedOut}: sign the account ${stored.account.name} in again`,
        'auth',
        { provider: provider.id },
      );
    }
    if (!force && lasts > RENEW_BEFORE_MS) return { credential, renewed: false };
    const renewed = await this.#locked(id, () => this.#renew(id, provider, stored.sealed));
    return { credential: renewed, renewed: true };
  }

  /**
   * Renews a signed-in account's token, with what the sign-in left, and keeps it. When the
   * provider says the sign-in has ended, the account says so until it is signed in again.
   */
  async #renew(id: AccountId, provider: Provider, used: string): Promise<Credential> {
    const flow = provider.signIn;
    if (flow === undefined) throw new Error(`${provider.label} has no sign-in`);
    // As it is now: a renewal that this one waited for may have kept a newer token already.
    const stored = await this.#stored(id);
    const before = this.#open(stored);
    const lasts =
      before.type === 'access_token' && before.expiresAt !== undefined
        ? before.expiresAt - this.#clock()
        : Infinity;
    if (stored.sealed !== used && lasts > RENEW_BEFORE_MS) return before;
    let renewed: Credential;
    try {
      renewed = await flow.renew(before, this.#signInSettings());
    } catch (error) {
      if (error instanceof ModelFailure && error.kind === 'auth') {
        await this.#store.saveAccount({
          ...stored,
          account: {
            ...stored.account,
            signIn: { email: stored.account.signIn?.email ?? null, signedOut: error.message },
          },
        });
      }
      throw error;
    }
    await this.#store.saveAccount({ ...stored, sealed: this.#seal(id, renewed) });
    return renewed;
  }

  #signInSettings(): { fetch?: typeof fetch } {
    return this.#fetch === undefined ? {} : { fetch: this.#fetch };
  }

  /** Runs `write` once every write of the account that came before it has ended. */
  async #locked<T>(id: AccountId, write: () => Promise<T>): Promise<T> {
    const before = this.#writing.get(id) ?? Promise.resolve();
    const done = before.then(write, write);
    const settled = done.catch(() => undefined);
    this.#writing.set(id, settled);
    try {
      return await done;
    } finally {
      if (this.#writing.get(id) === settled) this.#writing.delete(id);
    }
  }

  #open(stored: StoredAccount): Credential {
    const { id } = stored.account;
    return JSON.parse(
      this.#secrets.open(sealedFor.account(id), stored.sealed, `The account ${id}`),
    ) as Credential;
  }

  async #defaultOf(provider: string): Promise<StoredAccount | undefined> {
    return (await this.#store.listAccounts()).find(
      ({ account }) => account.provider === provider && account.default,
    );
  }

  async #stored(id: AccountId): Promise<StoredAccount> {
    const stored = await this.#store.loadAccount(id);
    if (stored === undefined) throw new AccountNotFound(id);
    return stored;
  }

  async #shown(stored: StoredAccount): Promise<Account> {
    return { ...stored.account, actors: await this.#store.actorsGiven(stored.account.id) };
  }

  #seal(id: AccountId, credential: Credential): string {
    return this.#secrets.seal(sealedFor.account(id), JSON.stringify(credential));
  }

  /** Makes an account its provider's only default. */
  /** Asks a provider whether it takes a credential, and refuses the account when it does not. */
  async #check(providerId: string, credential: Credential): Promise<void> {
    if (!this.#providers.has(providerId)) {
      const has = this.#providers.list().map((provider) => provider.id);
      throw new InvalidAccount(`There is no provider ${providerId}: there are ${has.join(', ')}`);
    }
    const provider = this.#providers.get(providerId);
    if (!provider.credentials.includes(credential.type) || provider.check === undefined) {
      throw new InvalidAccount(
        `An account of ${provider.label} is not made with a key: it is made by signing in`,
      );
    }
    try {
      await provider.check({
        credential,
        ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
      });
    } catch (error) {
      if (!(error instanceof ModelFailure)) throw error;
      if (error.kind === 'auth') throw new InvalidAccount(error.message);
      throw new ProviderUnreachable(error.message);
    }
  }
}
