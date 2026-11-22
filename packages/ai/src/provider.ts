// A provider: somewhere a model is called. Each is a module of its own, which writes its own
// request from first to last and reads its own answer. The engine knows none of them by name:
// it asks the one an agent names for a runner, and calls that.
//
// So a provider is added by writing one, and nothing here or in the engine changes for it.

import type { AssistantMessage, Message, ProviderFields, Reasoning } from '@acentric/protocol';

import type { ModelInfo } from './catalog.ts';
import type { ModelRunner, ToolCall } from './runner.ts';

/** What a call is made with: a key of the provider's, or the token of someone signed in to it. */
export type Credential =
  | { readonly type: 'api_key'; readonly apiKey: string }
  | { readonly type: 'access_token'; readonly accessToken: string };

export type CredentialType = Credential['type'];

/** What a runner is made with. */
export type RunnerSettings = {
  readonly credential: Credential;
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

/** Reads `webSearch` out of what an agent asks, for the providers that have a search. */
export function readWebSearch(given: unknown, label: string): WebSearch | undefined {
  if (given === undefined) return undefined;
  if (given === true) return true;
  const domains = (value: unknown): value is string[] =>
    Array.isArray(value) && value.length > 0 && value.every((domain) => typeof domain === 'string');
  if (typeof given === 'object' && given !== null) {
    const { allowedDomains, blockedDomains, ...rest } = given as { [key: string]: unknown };
    if (Object.keys(rest).length === 0) {
      if (domains(allowedDomains) && blockedDomains === undefined) return { allowedDomains };
      if (domains(blockedDomains) && allowedDomains === undefined) return { blockedDomains };
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
