// An input: one type of thing that can be sent to an actor, the schema it must pass, and what
// it becomes in the conversation.

import type { Content } from './content.ts';
import type { Context, Machine } from './context.ts';
import type { OutputOf, Schema } from './schema.ts';

/** `S` is the schema of what is sent, and `TConfig` the actor's configuration. */
export type Input<
  S extends Schema = Schema,
  TConfig = unknown,
  TMachine extends Machine | null = Machine | null,
> = {
  readonly schema: S;
  /** Turns what was sent, as `schema` returned it, into a message for the model. */
  readonly handler: (
    payload: OutputOf<S>,
    context: Context<TConfig, TMachine>,
  ) => Content | Promise<Content>;
};

/** The schemas of an agent's inputs, by type. */
export type InputSchemas = { readonly [type: string]: Schema };
