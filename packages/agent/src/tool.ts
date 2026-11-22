// A tool an agent brings: what the model is told of it, and the code that answers a call. A
// call runs `execute` and is answered with what it returns.

import type { Content } from './content.ts';
import type { Context, Machine } from './context.ts';
import type { OutputOf, ToolSchema } from './schema.ts';

/**
 * `S` is the schema of the tool's arguments, and `TConfig` the configuration its code expects
 * of the actor. A tool that reads no configuration leaves `TConfig` out, and fits any agent.
 */
export type Tool<
  S extends ToolSchema = ToolSchema,
  TConfig = unknown,
  TMachine extends Machine | null = Machine | null,
> = {
  readonly name: string;
  /** What the tool does, for the model. */
  readonly description: string;
  /** The schema of the arguments. `execute` is given them as it returns them. */
  readonly parameters: S;
  /**
   * `true` makes the tool a function in the scripts the model writes, and it is then not
   * offered to the model itself. Without it, the model calls the tool directly.
   */
  readonly codemode?: boolean;
  /**
   * What happens to a call that a crash cut off while `execute` ran. `true` says the call is
   * safe to make again, and it is run again. Without it, the call is made once only: it is not
   * run again, and its result is an error that says it was cut off and may or may not have run.
   */
  readonly retrySafe?: boolean;
  readonly execute: (
    args: OutputOf<S>,
    context: Context<TConfig, TMachine>,
  ) => Content | Promise<Content>;
};

/** A tool whose arguments are of any schema: what a list of tools holds. */
// The arguments are `any` so that tools of different schemas fit in one list.
export type AnyTool<TConfig = unknown, TMachine extends Machine | null = Machine | null> = Tool<
  any,
  TConfig,
  TMachine
>;

/**
 * Defines a tool. It returns the tool as it is: it is here so that `execute` is given the
 * arguments typed by `parameters`.
 *
 *     const lookupOrder = tool({
 *       name: 'lookup_order',
 *       description: 'Finds an order by its ID.',
 *       parameters: z.object({ id: z.string() }),
 *       execute: ({ id }) => `Order ${id} was shipped.`,
 *     });
 *
 * A tool written outside its agent that reads the configuration says which one it expects, on
 * its context: `execute: (args, context: Context<Config>) => …`.
 */
export function tool<S extends ToolSchema, TConfig = unknown>(
  definition: Tool<S, TConfig>,
): Tool<S, TConfig> {
  return definition;
}
