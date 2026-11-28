// A provider: somewhere a model is called. Each is a module of its own, which writes its own
// request from first to last and reads its own answer. The engine knows none of them by name:
// it asks the one an agent names for a runner, and calls that.
//
// So a provider is added by writing one, and nothing here or in the engine changes for it.

import type {
  AssistantMessage,
  JsonObject,
  Message,
  ProviderFields,
  Reasoning,
} from '@acentric/protocol';

import type { ModelInfo } from './catalog.ts';
import type { ModelRunner, ToolCall } from './runner.ts';

/** What a call is made with: a key of the provider's, or the token of someone signed in to it. */
export type Credential =
  | { readonly type: 'api_key'; readonly apiKey: string }
  | {
      readonly type: 'access_token';
      readonly accessToken: string;
      /** When the token stops being taken, in milliseconds since 1970. Left out: it does not. */
      readonly expiresAt?: number;
      /**
       * What the provider renews the token with and ends the sign-in by. It is the provider's
       * own: nothing else reads it.
       */
      readonly session?: JsonObject;
    }
  /**
   * A sign-in that a program of the provider's keeps itself, on the engine's host, in a folder
   * of its own: `home` names the folder among the provider's. The engine never reads what is
   * kept there, and the program renews it.
   */
  | { readonly type: 'local_sign_in'; readonly home: string };

export type CredentialType = Credential['type'];

/** What a runner is made with. */
export type RunnerSettings = {
  readonly credential: Credential;
  /** Where a provider that keeps a conversation of its own beside the engine's keeps it. */
  readonly logs?: SessionLogs;
  /** In place of the world's `fetch`: how a test answers for the provider. */
  readonly fetch?: typeof fetch;
};

/** An answer, read for showing to a person. */
export type AnswerView = {
  /** What it says. */
  readonly text: string;
  /** What it gives of its reasoning, in order. Empty when it gives none. */
  readonly reasoning: readonly string[];
  readonly toolCalls: readonly ToolCall[];
};

export interface Provider {
  /** Its ID, as an agent names it. */
  readonly id: string;
  /** Its name, for a person. */
  readonly label: string;
  /** The kinds of credential its calls can be made with. */
  readonly credentials: readonly CredentialType[];
  /** The models it is known to serve. Another ID is tried as it is. */
  readonly models: readonly ModelInfo[];
  /** The model an actor runs on when it is created without one. */
  readonly defaultModel: string;
  /**
   * Whether the reasoning of a model that is not among `models` is taken to be tied to what
   * came before it (see `ModelInfo.bindsReasoning`). True is the safe answer: reasoning that
   * was left out is never refused, and reasoning that was sent may be.
   */
  readonly bindsReasoning: boolean;
  /**
   * Checks what an agent asks of this provider that only it has, and gives it back as its
   * runner reads it. Throws, with what is wrong, when it asks what the provider has not.
   */
  parseOptions(given: unknown): ProviderFields;
  runner(settings: RunnerSettings): ModelRunner;
  /**
   * How the provider compacts a conversation itself, when asked with a step that says
   * `compact`. A provider without it has none, and a summary is written by its model instead.
   *
   *   older  It is sent the older part of a conversation, and answers with one block that
   *          stands for that part. The recent turns follow the block as they were, with the
   *          model's reasoning.
   *   all    It is sent the whole conversation, and answers with one item that stands for
   *          all of it, the model's reasoning included.
   *   inside It keeps a conversation of its own, and compacts that itself when it grows past
   *          a step's `compactAt`. The engine never compacts the conversation it keeps, and
   *          never sends a step that says `compact`.
   */
  readonly compacts?: 'older' | 'all' | 'inside';
  /**
   * An answer to a step that said `compact`, with only what stands for the conversation in
   * it, exactly as it came. Undefined when the answer has no such thing, or more than one.
   */
  compacted?(message: AssistantMessage): AssistantMessage | undefined;
  /**
   * Its calls are a plan's, not paid by the token: no size of a conversation costs more a
   * token than another.
   */
  readonly plan?: true;
  /** Reads an answer this provider wrote. */
  read(message: AssistantMessage): AnswerView;
  /** An answer this provider wrote, without what it gives of its reasoning. */
  withoutReasoning(message: AssistantMessage): AssistantMessage;
  /**
   * Asks the provider whether it takes a credential, without calling a model. Rejects with a
   * `ModelFailure`: of kind `auth` when the provider refuses it, and of another kind when the
   * provider could not be asked. A provider without it cannot be asked.
   */
  check?(settings: RunnerSettings): Promise<void>;
  /**
   * For a provider whose reasoning level can be changed from a place in a conversation on:
   * the message that changes it, to be put at the conversation's end. The request's own level
   * then stays the one the conversation started with, and what the provider keeps of the
   * conversation stays good. A provider without it takes a level only with the request.
   */
  reasoningChange?(model: string, reasoning: Reasoning): Message;
  /**
   * For a provider whose accounts are made by someone signing in at the provider, in a
   * browser: how. A provider without it has its accounts made with a key.
   */
  readonly signIn?: SignInFlow;
  /** Stops what the provider runs of its own, such as processes, when the engine stops. */
  close?(): Promise<void>;
}

/**
 * What a provider keeps of one conversation beside the engine's, for a provider that keeps
 * its own (see `RunnerSettings.logs`): entries of JSON in order, under streams it names. It
 * goes when the conversation does.
 */
export interface SessionLog {
  /** The entries of a stream, oldest first. Empty for one with none. */
  read(stream: string): Promise<JsonObject[]>;
  append(stream: string, entries: readonly JsonObject[]): Promise<void>;
  /** Keeps these under a stream in place of what it had. */
  replace(stream: string, entries: readonly JsonObject[]): Promise<void>;
  /** The streams that have entries. */
  streams(): Promise<string[]>;
  /** Forgets every stream. */
  clear(): Promise<void>;
}

/** The log of a conversation, by the `session` its steps name. */
export type SessionLogs = (session: string) => SessionLog;

/** What a sign-in's calls to the provider are made with. */
export type SignInSettings = {
  /** In place of the world's `fetch`: how a test answers for the provider. */
  readonly fetch?: typeof fetch;
};

/**
 * Signing in at a provider in a browser, to make an account of it, or to sign one in again.
 * The engine starts one, the person signs in at the page it gives, and the address their
 * browser is sent back to finishes it.
 */
export interface SignInFlow {
  /** How long a sign-in that was started may wait to be finished, in milliseconds. */
  readonly waitsMs: number;
  /**
   * Starts a sign-in. `host` is the engine's own ID as a host, the same for all of its
   * sign-ins. `again` is the credential of the account that is being signed in again.
   * `client` is what the provider registered for a sign-in that did not finish, as its
   * `SignInRefused` said: it is started again with that.
   */
  start(given: {
    readonly host: string;
    readonly again?: Credential;
    readonly client?: string;
  }): Promise<SignInStart>;
  /**
   * Finishes a sign-in from the address the person's browser was sent back to. Rejects with a
   * `SignInRefused` when that address does not make an account, and with a `ModelFailure` when
   * the provider could not be asked.
   */
  finish(pending: JsonObject, returned: string, settings: SignInSettings): Promise<SignedIn>;
  /**
   * A token that is about to stop being taken, renewed. Rejects with a `ModelFailure`: of kind
   * `auth` when the sign-in has ended and the account has to be signed in again, and of
   * another kind when the provider could not be asked.
   */
  renew(credential: Credential, settings: SignInSettings): Promise<Credential>;
  /** Ends a sign-in at the provider. Rejects when the provider did not say it has. */
  end(credential: Credential, settings: SignInSettings): Promise<void>;
  /**
   * Gives up a sign-in that was started and will not be finished: it was cancelled, or it
   * expired. A flow without it holds nothing for one.
   */
  abandon?(pending: JsonObject): void;
}

export type SignInStart = {
  /** The page the person signs in at. */
  readonly url: string;
  /** What the sign-in keeps until it is finished. It is the provider's own, and never shown. */
  readonly pending: JsonObject;
};

export type SignedIn = {
  readonly credential: Credential;
  /** Whose sign-in it is, when the provider said. */
  readonly email: string | null;
};

/** The address a sign-in was finished with does not make an account: what is wrong, for a person. */
export class SignInRefused extends Error {
  override readonly name = 'SignInRefused';
  /**
   * What the provider registered for this sign-in before it was refused, when it is to be
   * started again with that, and not registered once more.
   */
  readonly client: string | undefined;
  constructor(message: string, more: { readonly client?: string } = {}) {
    super(message);
    this.client = more.client;
  }
}

/**
 * Whether a model's reasoning is tied to what came before it: what is known of the model, or
 * else what its provider says of the models it does not know.
 */
export function bindsReasoning(provider: Provider, model: string): boolean {
  const known = provider.models.find((info) => info.id === model);
  return known?.bindsReasoning ?? provider.bindsReasoning;
}

/** An answer without the items of its content that have one of these types. */
export function withoutTypes(
  message: AssistantMessage,
  types: readonly string[],
): AssistantMessage {
  const content = message.content.filter((item) => !types.includes(String(item['type'])));
  return content.length === message.content.length ? message : { ...message, content };
}

export class UnknownProvider extends Error {
  override readonly name = 'UnknownProvider';
  constructor(id: string, known: readonly string[]) {
    super(`There is no provider ${id}: there are ${known.join(', ')}`);
  }
}

/** The providers an engine has. */
export class Providers {
  readonly #byId = new Map<string, Provider>();

  constructor(providers: readonly Provider[] = []) {
    for (const provider of providers) this.add(provider);
  }

  add(provider: Provider): this {
    if (this.#byId.has(provider.id)) throw new Error(`There is a provider ${provider.id} already`);
    this.#byId.set(provider.id, provider);
    return this;
  }

  get(id: string): Provider {
    const provider = this.#byId.get(id);
    if (provider === undefined) throw new UnknownProvider(id, [...this.#byId.keys()]);
    return provider;
  }

  has(id: string): boolean {
    return this.#byId.has(id);
  }

  list(): Provider[] {
    return [...this.#byId.values()];
  }
}

/** Which sites a provider's own web search looks at: all, only some, or all but some. */
export type WebSearch =
  | true
  | { readonly allowedDomains: readonly string[] }
  | { readonly blockedDomains: readonly string[] };

/** The most sites a search may be held to, or kept from: no provider takes more. */
const WEB_SEARCH_DOMAINS = 100;

/** Reads `webSearch` out of what an agent asks, for the providers that have a search. */
export function readWebSearch(given: unknown, label: string): WebSearch | undefined {
  if (given === undefined) return undefined;
  if (given === true) return true;
  const domains = (value: unknown, field: string): value is string[] => {
    if (!Array.isArray(value) || value.length === 0) return false;
    // A domain, or a domain and a path under it: no `https://`, and no port.
    if (
      value.length > WEB_SEARCH_DOMAINS ||
      value.some((domain) => typeof domain !== 'string' || !/^[^\s/:]+(\/\S*)?$/.test(domain))
    ) {
      throw new TypeError(
        `${label}: webSearch.${field} is a list of 1 to ${String(WEB_SEARCH_DOMAINS)} domains, such as example.com, with no https://`,
      );
    }
    return true;
  };
  if (typeof given === 'object' && given !== null) {
    const { allowedDomains, blockedDomains, ...rest } = given as { [key: string]: unknown };
    if (Object.keys(rest).length === 0) {
      if (blockedDomains === undefined && domains(allowedDomains, 'allowedDomains')) {
        return { allowedDomains };
      }
      if (allowedDomains === undefined && domains(blockedDomains, 'blockedDomains')) {
        return { blockedDomains };
      }
    }
  }
  throw new TypeError(
    `${label}: webSearch is true, or allowedDomains, or blockedDomains, as a list of domains`,
  );
}

/** Refuses what an agent asks of a provider beyond the fields it has. */
export function onlyOptions(
  given: unknown,
  known: readonly string[],
  label: string,
): { [key: string]: unknown } {
  if (given === undefined || given === null) return {};
  if (typeof given !== 'object' || Array.isArray(given)) {
    throw new TypeError(`${label}: what an agent asks of its provider is an object`);
  }
  for (const key of Object.keys(given)) {
    if (!known.includes(key)) {
      const has = known.length === 0 ? 'nothing of its own to ask' : known.join(', ');
      throw new TypeError(`${label} has no ${key}: it has ${has}`);
    }
  }
  return given as { [key: string]: unknown };
}

/**
 * What a model is sent for a reasoning level: the level's own value when the model takes it,
 * otherwise that of the nearest level it takes, the higher one when two are as near.
 */
export function effortOf(
  levels: { readonly [level: string]: string | undefined },
  reasoning: string,
): string {
  const order = ['low', 'medium', 'high', 'xhigh', 'max'];
  const asked = order.indexOf(reasoning);
  let best: { readonly value: string; readonly distance: number } | undefined;
  for (const [index, level] of order.entries()) {
    const value = levels[level];
    if (value === undefined) continue;
    const distance = Math.abs(index - asked);
    // In order from the lowest, so a later one as near is the higher of the two.
    if (best === undefined || distance <= best.distance) best = { value, distance };
  }
  return best?.value ?? reasoning;
}
