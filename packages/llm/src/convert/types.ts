// The shapes conversion works with.

import type { JsonObject } from '@acentric/types';

import type { ApiFormat, Provider } from '../providers.js';

/** The provider and model a conversation is converted for. */
export type ConvertTarget<P extends Provider = Provider> = {
  readonly provider: P;
  readonly model: string;
};

export type ConvertOptions = {
  /**
   * Reasoning the target cannot use as it is: another model's signed or
   * encrypted reasoning, and any reasoning sent to another provider. `drop`,
   * the default, leaves it out. `text` keeps its readable text: as a plain
   * reasoning item where the target reads one (Fireworks), otherwise as
   * assistant text. Reasoning with no readable text is dropped either way.
   */
  readonly reasoning?: 'drop' | 'text';
};

/** One thing `convert` dropped or rewrote. */
export type ConversionChange = {
  /** The message's index in the input. */
  readonly index: number;
  readonly action: 'dropped' | 'rewritten';
  readonly what:
    | 'message'
    | 'reasoning'
    | 'tool_call'
    | 'tool_result'
    | 'tool_call_id'
    | 'tool_arguments'
    | 'provider_item'
    | 'citations'
    | 'refusal'
    | 'part'
    | 'part_option';
  /** What exactly, for logs, such as `web_search_call` or `cache_control`. */
  readonly detail: string;
};

/** The converted messages, and every change made to get them. */
export type Conversion<M> = {
  readonly messages: M[];
  readonly changes: readonly ConversionChange[];
};

/** What a target provider takes, as far as conversion cares. */
export type Capabilities = {
  readonly api: ApiFormat;
  /** Free-form custom tools and their calls. */
  readonly customTools: boolean;
  /** File parts. */
  readonly files: boolean;
  /** Images and files by a provider's file ID. */
  readonly fileIds: boolean;
  /** Reads reasoning items that hold only text. */
  readonly plainReasoning: boolean;
};

export type Target = Capabilities & ConvertTarget;

/** One assistant item read without its format, on its way to another format. Never stored. */
export type Common =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'refusal'; readonly text: string }
  | { readonly kind: 'reasoning'; readonly text: string }
  | {
      readonly kind: 'call';
      readonly id: string;
      readonly name: string;
      readonly arguments: string;
    }
  | {
      readonly kind: 'custom_call';
      readonly id: string;
      readonly name: string;
      readonly input: string;
    }
  | { readonly kind: 'other'; readonly type: string };

/** What a conversation's conversion shares from message to message. */
export type Context = {
  readonly target: Target;
  readonly reasoning: 'drop' | 'text';
  /** Call IDs whose calls were dropped; their results are dropped too. */
  readonly droppedCalls: Set<string>;
  change(action: ConversionChange['action'], what: ConversionChange['what'], detail: string): void;
  /** A call ID as the target takes it. Results are mapped the same way. */
  callId(id: string): string;
};

/** One API format's side of conversion. */
export type FormatConverter = {
  /** The items of a message from another provider or model in this same format. */
  sameFormat(items: readonly JsonObject[], sameProvider: boolean, context: Context): JsonObject[];
  /** The items of a message in this format, read for another format. */
  read(items: readonly JsonObject[], context: Context): Common[];
  /** Common items written as this format's. */
  write(items: readonly Common[], context: Context): JsonObject[];
};
