// A tool of the engine's own that answers at once, not a task: such as `spawn_agent`.

import type { Actor, AgentDefinition, ContentPart, JsonObject } from '@acentric/protocol';

import type { EngineTool } from './tasks.ts';

/** A tool of the engine's own that answers at once. */
export type OwnTool = {
  readonly tool: EngineTool;
  /** Whether an actor's model is offered it. */
  available(actor: Actor, definition: AgentDefinition): boolean;
  /** Its description for an actor, when it is not the same for every one. */
  describe?(actor: Actor, definition: AgentDefinition): string;
  /** It is run before the other calls of the answer it is in, which may be of what it makes. */
  readonly first?: boolean;
  /**
   * Runs it. It is safe to run again: a call that was cut off is made again, with the same
   * `call.id`, by which it can tell that it is the same call.
   */
  run(
    actor: Actor,
    definition: AgentDefinition,
    args: JsonObject,
    call: { readonly id: string },
  ): Promise<{ readonly content: string | readonly ContentPart[]; readonly isError?: boolean }>;
};

/** A tool of the engine's own as an actor's model is told of it. */
export function offered(one: OwnTool, actor: Actor, definition: AgentDefinition): EngineTool {
  const description = one.describe?.(actor, definition);
  return description === undefined ? one.tool : { ...one.tool, description };
}
