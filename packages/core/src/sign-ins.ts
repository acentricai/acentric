// Signing in at a provider, to make a model account of it or to sign one in again, for a
// provider whose accounts have no key, such as ChatGPT.
//
// The engine starts a sign-in and answers the page to sign in at. The person signs in there in
// their own browser, which is then sent to an address on their own computer: the engine is
// often not there, so the person gives that address back, and the sign-in is finished with it.
// What a sign-in keeps until then is the provider's own, and is kept in memory only: a sign-in
// that waits is lost when the server stops, and is started again.

import { ModelFailure, SignInRefused } from '@acentric/ai';
import type { Credential, Providers, SignInFlow } from '@acentric/ai';
import type {
  Account,
  AccountId,
  JsonObject,
  PrincipalRef,
  SignIn,
  SignInId,
  StartSignInRequest,
} from '@acentric/protocol';

import { InvalidAccount, ProviderUnreachable } from './accounts.ts';
import type { Accounts } from './accounts.ts';
import { Conflict, EngineError } from './errors.ts';
import { IdSource } from './ids.ts';
import { NameTaken } from './store.ts';
import type { Store } from './store.ts';

export class SignInNotFound extends EngineError {
  override readonly name = 'SignInNotFound';
  readonly code = 'not_found';
  constructor(id: string) {
    super(
      `There is no sign-in ${id} waiting: it was finished, given up, or it expired. Start another`,
    );
  }
}

/** The most sign-ins that may wait at once: each holds a little memory until it expires. */
const MOST_WAITING = 100;

type Waiting = {
  readonly provider: string;
  readonly flow: SignInFlow;
  /** What it makes: a new account, or one signed in again. */
  readonly for:
    { readonly name: string; readonly default?: boolean } | { readonly account: AccountId };
  /** The credential of the account it signs in again. */
  readonly again: Credential | undefined;
  /** The page it is signed in at, and what it keeps: both new when it is started again. */
  url: string;
  pending: JsonObject;
  expiresAt: number;
  /** Whether it is being finished now: a second address waits for the first to be tried. */
  finishing: boolean;
};

export class SignIns {
  readonly #store: Store;
  readonly #providers: Providers;
  readonly #accounts: Accounts;
  readonly #clock: () => number;
  readonly #ids: IdSource;
  readonly #fetch: typeof fetch | undefined;
  readonly #waiting = new Map<SignInId, Waiting>();

  constructor(options: {
    readonly store: Store;
    readonly providers: Providers;
    readonly accounts: Accounts;
    readonly clock?: () => number;
    readonly entropy?: () => Uint8Array;
    /** In place of the world's `fetch`, for the provider's sign-in. */
    readonly fetch?: typeof fetch;
  }) {
    this.#store = options.store;
    this.#providers = options.providers;
    this.#accounts = options.accounts;
    this.#clock = options.clock ?? Date.now;
    this.#ids = new IdSource(options.entropy ?? (() => crypto.getRandomValues(new Uint8Array(10))));
    this.#fetch = options.fetch;
  }

  /** Starts a sign-in at `provider`: for a new account, or to sign `account` in again. */
  async start(provider: string, given: StartSignInRequest): Promise<SignIn> {
    const flow = this.#flowOf(provider);
    const now = this.#clock();
    this.#forget(now);
    if (this.#waiting.size >= MOST_WAITING) {
      throw new Conflict('Too many sign-ins are waiting: finish or give one up first');
    }
    let again;
    if ('account' in given) {
      const { provider: of, credential } = await this.#accounts.signedInWith(given.account);
      if (of.id !== provider) {
        throw new InvalidAccount(`The account ${given.account} is of ${of.label}`);
      }
      again = credential;
    } else {
      // Said now, not once the person has signed in.
      const accounts = await this.#store.listAccounts();
      if (accounts.some(({ account }) => account.name === given.name)) {
        throw new NameTaken(given.name, 'account');
      }
    }
    const host = await this.#store.hostId();
    let started;
    try {
      started = await flow.start({ host, ...(again === undefined ? {} : { again }) });
    } catch (error) {
      if (error instanceof ModelFailure) throw new ProviderUnreachable(error.message);
      throw error;
    }
    const { url, pending } = started;
    const id = this.#ids.make('signIn', now);
    const expiresAt = now + flow.waitsMs;
    this.#waiting.set(id, {
      provider,
      flow,
      for:
        'account' in given
          ? { account: given.account }
          : {
              name: given.name,
              ...(given.default === undefined ? {} : { default: given.default }),
            },
      again,
      url,
      pending,
      expiresAt,
      finishing: false,
    });
    return this.#shown(id, this.#waitingFor(id));
  }

  /** A sign-in that waits: the page it is signed in at, which is new once it was started again. */
  get(id: SignInId): SignIn {
    return this.#shown(id, this.#waitingFor(id));
  }

  /**
   * Finishes a sign-in with the address the person's browser was sent to once they had signed
   * in, and makes its account, or signs its account in again. An address that does not finish
   * it leaves it waiting, for another to be given until it expires.
   */
  async finish(by: PrincipalRef, id: SignInId, returned: string): Promise<Account> {
    const waiting = this.#waitingFor(id);
    if (waiting.finishing) throw new Conflict('This sign-in is being finished already');
    waiting.finishing = true;
    let signedIn;
    try {
      signedIn = await waiting.flow.finish(waiting.pending, returned, this.#settings());
    } catch (error) {
      if (error instanceof SignInRefused) {
        // The provider registered something for it already: it waits again, on a new page,
        // started with that.
        if (error.client !== undefined) await this.#restart(waiting, error.client);
        throw new InvalidAccount(error.message);
      }
      if (error instanceof ModelFailure) throw new ProviderUnreachable(error.message);
      throw error;
    } finally {
      waiting.finishing = false;
    }
    this.#waiting.delete(id);
    try {
      return 'account' in waiting.for
        ? await this.#accounts.signInAgain(by, waiting.for.account, signedIn)
        : await this.#accounts.addSignedIn(
            by,
            { provider: waiting.provider, ...waiting.for },
            signedIn,
          );
    } catch (error) {
      // Nothing keeps it: it is ended where it was made.
      await waiting.flow.end(signedIn.credential, this.#settings()).catch(() => undefined);
      throw error;
    }
  }

  /** Starts a sign-in that waits again, with what its provider registered for it. */
  async #restart(waiting: Waiting, client: string): Promise<void> {
    const host = await this.#store.hostId();
    const { url, pending } = await waiting.flow.start({
      host,
      client,
      ...(waiting.again === undefined ? {} : { again: waiting.again }),
    });
    waiting.url = url;
    waiting.pending = pending;
    waiting.expiresAt = this.#clock() + waiting.flow.waitsMs;
  }

  #shown(id: SignInId, waiting: Waiting): SignIn {
    return {
      id,
      url: waiting.url,
      expiresAt: waiting.expiresAt,
      ...('account' in waiting.for ? { account: waiting.for.account } : {}),
    };
  }

  /** Gives up a sign-in that waits: an address given for it later finishes nothing. */
  cancel(id: SignInId): void {
    const waiting = this.#waitingFor(id);
    this.#waiting.delete(id);
    waiting.flow.abandon?.(waiting.pending);
  }

  #waitingFor(id: SignInId): Waiting {
    this.#forget(this.#clock());
    const waiting = this.#waiting.get(id);
    if (waiting === undefined) throw new SignInNotFound(id);
    return waiting;
  }

  /** Forgets the sign-ins that expired. */
  #forget(now: number): void {
    for (const [id, waiting] of this.#waiting) {
      if (waiting.expiresAt <= now && !waiting.finishing) {
        this.#waiting.delete(id);
        waiting.flow.abandon?.(waiting.pending);
      }
    }
  }

  #flowOf(provider: string): SignInFlow {
    if (!this.#providers.has(provider))
      throw new InvalidAccount(`There is no provider ${provider}`);
    const of = this.#providers.get(provider);
    if (of.signIn === undefined) {
      throw new InvalidAccount(`${of.label} is not signed in to: its accounts are made with a key`);
    }
    return of.signIn;
  }

  #settings(): { fetch?: typeof fetch } {
    return this.#fetch === undefined ? {} : { fetch: this.#fetch };
  }
}
