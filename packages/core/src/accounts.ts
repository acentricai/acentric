// Model accounts: what the calls of a provider's models are made with.
//
// An account is a key of a provider's, kept sealed. There can be several for a provider, and
// one of them is that provider's default. An agent's calls are made with the account it was
// given, or with its provider's default. An agent's own secrets never hold a model key.
//
// A key is checked with its provider when it is added or replaced: an account that is kept is
// one its provider takes. Nothing gives a key back.

import { ModelFailure } from '@acentric/ai';
import type { Credential, ModelRunner, Providers } from '@acentric/ai';
import type { Account, AccountId, Agent, AgentId, PrincipalRef } from '@acentric/protocol';

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
   * Removes an account that no agent is given. When it was its provider's default, the oldest
   * of that provider's other accounts is the default from then on.
   */
  async remove(by: PrincipalRef, id: AccountId): Promise<void> {
    const stored = await this.#stored(id);
    const agents = await this.#store.agentsOf(id);
    if (agents.length > 0) {
      throw new Conflict(
        `The agents ${agents.join(', ')} are given this account: give them another first`,
      );
    }
    await this.#store.removeAccount(id);
    this.#runners.delete(id);
    if (stored.account.default) {
      const [next] = (await this.#store.listAccounts()).filter(
        ({ account }) => account.provider === stored.account.provider,
      );
      if (next !== undefined) {
        await this.#store.saveAccount({ ...next, account: { ...next.account, default: true } });
      }
    }
    await this.#audit?.record({
      by,
      action: 'account.delete',
      target: { type: 'account', id },
      detail: { provider: stored.account.provider, name: stored.account.name },
    });
  }

  /**
   * Gives an agent an account of its provider, or with null none: its calls are then made
   * with its provider's default.
   */
  async give(by: PrincipalRef, agent: Agent, account: AccountId | null): Promise<Agent> {
    if (account !== null) {
      const stored = await this.#stored(account);
      if (stored.account.provider !== agent.provider) {
        throw new Conflict(
          `The agent ${agent.name} is of the provider ${agent.provider}, and the account ${stored.account.name} of ${stored.account.provider}`,
        );
      }
    }
    const given = await this.#store.setAgentAccount(agent.id, account);
    if (given === undefined) throw new Conflict(`There is no agent ${agent.id}`);
    await this.#audit?.record({
      by,
      action: 'agent.account',
      target: { type: 'agent', id: agent.id },
      detail: { account },
    });
    return given;
  }

  /**
   * What an agent's model calls are made with: the account it was given, or its provider's
   * default, and a runner made with that account's credential. Throws, with what to do about
   * it, when its provider has no account.
   */
  async access(agent: AgentId): Promise<Access> {
    const of = await this.#store.loadAgent(agent);
    if (of === undefined) throw new Error(`There is no agent ${agent}`);
    const provider = this.#providers.get(of.provider);
    const stored =
      of.account === null
        ? (await this.#store.listAccounts()).find(
            ({ account }) => account.provider === of.provider && account.default,
          )
        : await this.#store.loadAccount(of.account);
    if (stored === undefined) {
      throw new Error(
        `There is no model account for ${provider.label}: add one before its models are called`,
      );
    }
    const { id } = stored.account;
    let made = this.#runners.get(id);
    if (made?.sealed !== stored.sealed) {
      const opened = this.#secrets.open(sealedFor.account(id), stored.sealed, `The account ${id}`);
      const credential = JSON.parse(opened) as Credential;
      const runner = provider.runner({
        credential,
        ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
      });
      made = { sealed: stored.sealed, runner };
      this.#runners.set(id, made);
    }
    return { account: id, runner: made.runner };
  }

  async #stored(id: AccountId): Promise<StoredAccount> {
    const stored = await this.#store.loadAccount(id);
    if (stored === undefined) throw new AccountNotFound(id);
    return stored;
  }

  async #shown(stored: StoredAccount): Promise<Account> {
    return { ...stored.account, agents: await this.#store.agentsOf(stored.account.id) };
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
