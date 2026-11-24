// The Agent: what a developer defines and exports. It holds the definition and nothing of any
// one actor: an actor's model, reasoning, machine and configuration are given when the actor
// is created (see `actor.ts`).
//
// It has no ID and no name. An agent is named when it is deployed.

import { BUNDLE_ENTRY } from '@acentric/protocol/bundle';
import type { BundleEntry } from '@acentric/protocol/bundle';

import type { CreateActor } from './actor.ts';
import type { CompactionSettings } from './compaction.ts';
import type { MachineOf } from './context.ts';
import { entryOf } from './dispatch.ts';
import type { Input, InputSchemas } from './input.ts';
import type { Instructions } from './instructions.ts';
import type { McpServer } from './mcp.ts';
import type { Provider } from './models.ts';
import type { ScheduleOptions } from './schedule.ts';
import type { InputOf, Schema, ToolSchema } from './schema.ts';
import type { AnySubagent, Subagent } from './subagent.ts';
import type { AnyTool, Tool } from './tool.ts';
import type { WebSearch } from './web-search.ts';

/**
 * What a developer gives to define an agent. `P` is its provider. `TConfig` is its actors'
 * configuration, as the `configuration` schema returns it, and `TConfigInput` as a caller
 * gives it. `TInputs` are the schemas of its inputs, by type, `TTools` the schemas of its
 * tools, in order, and `TSubs` the schemas of what its subagents are spawned with. `M` is
 * whether its actors work on a machine. All seven are inferred.
 */
export type AgentOptions<
  P extends Provider = Provider,
  TConfig = undefined,
  // An agent with no inputs of its own has none in its type.
  TInputs extends InputSchemas = {},
  TConfigInput = TConfig,
  TTools extends readonly ToolSchema[] = readonly ToolSchema[],
  // Of any kind, so that a subagent with no schema does not stop the others' being inferred.
  TSubs extends readonly unknown[] = readonly unknown[],
  M extends boolean = false,
> = {
  /** The provider of the agent's model, by its ID. It is the same for as long as the agent is. */
  readonly provider: P;
  /**
   * Whether its actors work on a machine: each is created with one when `true`, and none is
   * when `false`, which it is without this. Its code's context has the machine's files.
   */
  readonly machine?: M;
  /**
   * What the model is told, besides what the engine tells it: text, or a function that makes
   * it for each actor from what the actor was created with, such as its configuration and
   * where it works. The function is pure and returns at once: it is run when an actor is
   * created, and its instructions stay what it returned. It is run again only when the actor
   * moves to another version of the agent, between turns.
   */
  readonly instructions: Instructions<NoInfer<TConfig>, NoInfer<M>>;
  /**
   * The schema of the configuration an actor is created with. What is given is checked
   * against it, and what it returns is in the context of the agent's code. Without it, an
   * actor takes no configuration.
   */
  readonly configuration?: Schema<TConfig, TConfigInput>;
  /**
   * The agent's own tools. One written here, as an object, has its arguments typed by its
   * `parameters` and its context by the agent's configuration. One written elsewhere is made
   * with `tool()`.
   */
  readonly tools?: {
    readonly [K in keyof TTools]: Tool<TTools[K], NoInfer<TConfig>, MachineOf<NoInfer<M>>>;
  };
  /** The MCP servers whose tools the model's scripts can call, by name. */
  readonly mcps?: {
    readonly [name: string]: McpServer<NoInfer<TConfig>, MachineOf<NoInfer<M>>>;
  };
  /** What can be sent to an actor, by type. */
  readonly inputs?: {
    readonly [K in keyof TInputs]: Input<TInputs[K], NoInfer<TConfig>, MachineOf<NoInfer<M>>>;
  };
  /**
   * The agents an actor may spawn. One with `params` has what the model fills in typed by its
   * `schema`, and its context by the agent's configuration.
   */
  readonly subagents?: {
    readonly [K in keyof TSubs]: Subagent<TSubs[K], NoInfer<TConfig>, MachineOf<NoInfer<M>>>;
  };
  /** Compaction numbers by model, in place of the engine's own. */
  readonly compactionSettings?: CompactionSettings<NoInfer<P>>;
  /** What the notice of a fired schedule says. Without it, the notice is the model's note. */
  readonly schedule?: ScheduleOptions<NoInfer<TConfig>, MachineOf<NoInfer<M>>>;
  /** The provider's own web search, which the model can use. Without it, the model has none. */
  readonly webSearch?: WebSearch<NoInfer<P>>;
  /**
   * The secrets the agent's code reads, by name. Naming them here lets a deploy say which are
   * not set on the engine yet. A secret that is not named can still be read.
   */
  readonly secrets?: readonly string[];
};

/**
 * An agent definition.
 *
 *     export default new Agent({
 *       provider: 'anthropic',
 *       instructions: 'You review changes.',
 *     });
 *
 * Instructions made for each actor:
 *
 *     export default new Agent({
 *       provider: 'anthropic',
 *       configuration: z.object({ repo: z.string() }),
 *       machine: true,
 *       instructions: ({ configuration, machine }) =>
 *         `You review changes to ${configuration.repo}, checked out at ${machine.cwd}.`,
 *     });
 */
export class Agent<
  P extends Provider = Provider,
  TConfig = undefined,
  TInputs extends InputSchemas = {},
  TConfigInput = TConfig,
  TTools extends readonly ToolSchema[] = readonly ToolSchema[],
  // Of any kind, so that a subagent with no schema does not stop the others' being inferred.
  TSubs extends readonly unknown[] = readonly unknown[],
  M extends boolean = false,
> {
  readonly provider: P;
  readonly machine: M;
  readonly instructions: Instructions<TConfig, M>;
  readonly configuration: Schema<TConfig, TConfigInput> | undefined;
  readonly tools: readonly AnyTool<TConfig, MachineOf<M>>[];
  readonly mcps: { readonly [name: string]: McpServer<TConfig, MachineOf<M>> };
  readonly inputs: { readonly [K in keyof TInputs]: Input<TInputs[K], TConfig, MachineOf<M>> };
  readonly subagents: readonly AnySubagent<TConfig, MachineOf<M>>[];
  readonly compactionSettings: CompactionSettings<P>;
  readonly schedule: ScheduleOptions<TConfig, MachineOf<M>> | undefined;
  readonly webSearch: WebSearch<P> | undefined;
  readonly secrets: readonly string[];

  constructor(options: AgentOptions<P, TConfig, TInputs, TConfigInput, TTools, TSubs, M>) {
    this.provider = options.provider;
    this.machine = (options.machine ?? false) as M;
    this.instructions = options.instructions;
    this.configuration = options.configuration;
    // Each tool was checked against its own schema where it was given: a list of them forgets which.
    this.tools = (options.tools ?? []) as readonly AnyTool<TConfig, MachineOf<M>>[];
    this.mcps = options.mcps ?? {};
    // An agent with no `inputs` has none: `TInputs` is then `{}`.
    this.inputs =
      options.inputs ??
      ({} as { readonly [K in keyof TInputs]: Input<TInputs[K], TConfig, MachineOf<M>> });
    this.subagents = (options.subagents ?? []) as readonly AnySubagent<TConfig, MachineOf<M>>[];
    this.compactionSettings = options.compactionSettings ?? {};
    this.schedule = options.schedule;
    this.webSearch = options.webSearch;
    this.secrets = options.secrets ?? [];
  }

  /**
   * What the engine talks to: the bundle's side of the protocol between the two. It is found
   * here, on what a bundle exports, and is nothing an agent's own code has a use for.
   */
  get [Symbol.for(BUNDLE_ENTRY)](): BundleEntry {
    return entryOf(this);
  }
}

/** An agent of any provider, configuration, inputs and tools. */
export type AnyAgent = Agent<any, any, any, any, any, any, any>;

/** The configuration of an agent's actors, as its code is given it in the context. */
export type ConfigurationOf<A extends AnyAgent> =
  A extends Agent<any, infer TConfig, any, any, any, any, any> ? TConfig : never;

/** What an actor of the agent is created with. */
export type CreateActorOf<A extends AnyAgent> =
  A extends Agent<infer P, any, any, infer TConfigInput, any, any, infer M>
    ? CreateActor<P, TConfigInput, M>
    : never;

/** What can be sent to an actor of the agent: for each input type, what its schema takes. */
export type InputsOf<A extends AnyAgent> =
  A extends Agent<any, any, infer TInputs, any, any, any, any>
    ? { readonly [K in keyof TInputs]: InputOf<TInputs[K]> }
    : never;
