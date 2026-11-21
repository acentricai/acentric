// THROWAWAY. The fake parts: a store and a bus in memory, a model that says what a test told
// it to, and an executor that calls an agent's functions where it stands.

import type {
  Actor,
  ActorEvent,
  ActorId,
  AgentDefinition,
  ConversationEntry,
  DeploymentId,
  Input,
  Json,
} from '@acentric/protocol';

import { StaleEpoch } from './interfaces.ts';
import type {
  ActorRecord,
  CallContext,
  CallResult,
  Change,
  EventBus,
  Executor,
  ModelAnswer,
  ModelRunner,
  ModelStep,
  Store,
  ToolCall,
  Turn,
} from './interfaces.ts';

/** A copy that shares nothing with what it was made from, as what a database gives back does. */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

type Kept = { actor: Actor; turn: Turn; epoch: number; nextSeq: number };

/**
 * A store in memory. Two engines given the same one are two processes on one database: what
 * one stored, the other reads.
 */
export class MemoryStore implements Store {
  readonly #actors = new Map<ActorId, Kept>();
  readonly #inputs = new Map<ActorId, Input[]>();
  readonly #entries = new Map<ActorId, ConversationEntry[]>();
  /** How many commits were stored, over every actor. */
  commits = 0;

  #pending(actor: ActorId): Input[] {
    return (this.#inputs.get(actor) ?? []).filter((input) => input.deliveredAt === null);
  }

  #record(kept: Kept): ActorRecord {
    const pendingInputs = this.#pending(kept.actor.id).length;
    return copy({ ...kept, actor: { ...kept.actor, pendingInputs } });
  }

  async createActor(actor: Actor): Promise<ActorRecord> {
    const kept: Kept = { actor: copy(actor), turn: { phase: 'idle' }, epoch: 0, nextSeq: 1 };
    this.#actors.set(actor.id, kept);
    return this.#record(kept);
  }

  async loadActor(id: ActorId): Promise<ActorRecord | undefined> {
    const kept = this.#actors.get(id);
    return kept === undefined ? undefined : this.#record(kept);
  }

  async commit(id: ActorId, epoch: number, change: Change): Promise<ActorRecord> {
    const kept = this.#actors.get(id);
    if (kept === undefined) throw new Error(`There is no actor ${id}`);
    if (kept.epoch !== epoch) throw new StaleEpoch(id, epoch, kept.epoch);

    kept.actor = { ...kept.actor, status: change.status, lastTurn: copy(change.lastTurn) };
    kept.turn = copy(change.turn);
    kept.epoch += 1;
    kept.nextSeq += change.append.length;
    this.#entries.set(id, [...(this.#entries.get(id) ?? []), ...copy(change.append)]);
    for (const input of this.#inputs.get(id) ?? []) {
      if (change.deliver.includes(input.id)) input.deliveredAt = change.at;
    }
    this.commits += 1;
    return this.#record(kept);
  }

  async addInput(input: Input): Promise<'accepted' | 'duplicate'> {
    const inputs = this.#inputs.get(input.actor) ?? [];
    const known =
      input.externalId !== null && inputs.some((other) => other.externalId === input.externalId);
    if (known) return 'duplicate';
    this.#inputs.set(input.actor, [...inputs, copy(input)]);
    return 'accepted';
  }

  async pendingInputs(actor: ActorId): Promise<Input[]> {
    return copy(this.#pending(actor));
  }

  async conversation(actor: ActorId): Promise<ConversationEntry[]> {
    return copy(this.#entries.get(actor) ?? []);
  }

  async unfinished(): Promise<ActorId[]> {
    return [...this.#actors.values()]
      .filter((kept) => kept.turn.phase !== 'idle' || this.#pending(kept.actor.id).length > 0)
      .map((kept) => kept.actor.id);
  }
}

export class MemoryBus implements EventBus {
  readonly #listeners = new Map<ActorId, Set<(event: ActorEvent) => void>>();

  publish(actor: ActorId, event: ActorEvent): void {
    for (const listener of this.#listeners.get(actor) ?? []) listener(copy(event));
  }

  subscribe(actor: ActorId, listener: (event: ActorEvent) => void): () => void {
    const listeners = this.#listeners.get(actor) ?? new Set();
    this.#listeners.set(actor, listeners);
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
}

/** An answer of the fake model that is text and nothing else. */
export function says(text: string): ModelAnswer {
  return {
    message: {
      role: 'assistant',
      provider: 'fake',
      api: 'fake',
      model: 'fake-1',
      content: [{ type: 'text', text }],
    },
    stopReason: 'stop',
    toolCalls: [],
  };
}

/** An answer of the fake model that calls tools. */
export function calls(...toolCalls: ToolCall[]): ModelAnswer {
  return {
    message: {
      role: 'assistant',
      provider: 'fake',
      api: 'fake',
      model: 'fake-1',
      content: toolCalls.map((call) => ({ type: 'tool_call', ...call })),
    },
    stopReason: 'tool_use',
    toolCalls,
  };
}

/** What a scripted model does at one call: an answer, or what works one out, or fails. */
export type Scripted = ModelAnswer | ((step: ModelStep) => ModelAnswer | Promise<ModelAnswer>);

/** A model that gives the answers a test wrote, one at each call, and keeps what it was called with. */
export class ScriptedRunner implements ModelRunner {
  readonly #script: Scripted[];
  readonly steps: ModelStep[] = [];

  constructor(script: readonly Scripted[]) {
    this.#script = [...script];
  }

  async run(step: ModelStep): Promise<ModelAnswer> {
    this.steps.push(copy(step));
    const next = this.#script.shift();
    if (next === undefined) throw new Error('The script has no more answers');
    return typeof next === 'function' ? next(step) : next;
  }
}

/** A function of an agent, as its code would have it. */
export type AgentFunction = (argument: Json, context: CallContext) => Json | Promise<Json>;

export type InlineAgent = {
  readonly definition: AgentDefinition;
  /** Its functions by path, such as `tools.lookup_order.execute`. */
  readonly functions: { readonly [path: string]: AgentFunction };
};

/** An executor with no isolation at all: it calls the agent's functions in this process. */
export class InlineExecutor implements Executor {
  readonly #agents: ReadonlyMap<DeploymentId, InlineAgent>;
  /** Every call that was made, in order. */
  readonly made: { readonly path: string; readonly argument: Json }[] = [];

  constructor(agents: ReadonlyMap<DeploymentId, InlineAgent>) {
    this.#agents = agents;
  }

  #agent(deployment: DeploymentId): InlineAgent {
    const agent = this.#agents.get(deployment);
    if (agent === undefined) throw new Error(`There is no deployment ${deployment}`);
    return agent;
  }

  async describe(deployment: DeploymentId): Promise<AgentDefinition> {
    return copy(this.#agent(deployment).definition);
  }

  async call(
    deployment: DeploymentId,
    path: string,
    argument: Json,
    context: CallContext,
  ): Promise<CallResult> {
    const called = this.#agent(deployment).functions[path];
    if (called === undefined) return { ok: false, error: `The agent has no ${path}` };
    this.made.push({ path, argument: copy(argument) });
    try {
      return { ok: true, value: await called(argument, context) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
