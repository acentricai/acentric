// THROWAWAY. The part that does things: it reads where an actor stands, does what is owed,
// and feeds what happened back to the machine. It is the same loop for a turn that goes on and
// for one found half done after a restart.

import { contentPartSchema, makeId } from '@acentric/protocol';
import type {
  Actor,
  ActorId,
  AgentId,
  ContentPart,
  DeploymentRef,
  ExternalId,
  Input,
  InputId,
  Json,
  Name,
  Reasoning,
  ToolResultMessage,
} from '@acentric/protocol';

import type {
  ActorRecord,
  CallContext,
  CallResult,
  Clock,
  Entropy,
  EventBus,
  Executor,
  ModelRunner,
  ModelStep,
  OwedCall,
  Store,
} from './interfaces.ts';
import { decide } from './machine.ts';
import type { MachineEvent } from './machine.ts';

export type EngineParts = {
  readonly store: Store;
  readonly runner: ModelRunner;
  readonly executor: Executor;
  readonly bus: EventBus;
  readonly clock: Clock;
  readonly entropy: Entropy;
};

export class ActorNotFound extends Error {
  override readonly name = 'ActorNotFound';
}

export class InputRefused extends Error {
  override readonly name = 'InputRefused';
}

/** What a function of an agent returned, as content: text as it is, anything else as JSON. */
function contentOf(value: Json): ContentPart[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  const parts = contentPartSchema.array().safeParse(value);
  return parts.success ? parts.data : [{ type: 'text', text: JSON.stringify(value) }];
}

export class Engine {
  readonly #parts: EngineParts;
  /** The actors this engine is driving now. In one process, this is what keeps an actor to one driver. */
  readonly #driving = new Map<ActorId, Promise<void>>();
  /** Actors woken while they were being driven: each is looked at once more when its drive ends. */
  readonly #again = new Set<ActorId>();
  /** What a drive ended on that was not the actor's own failure, such as a stale epoch. */
  readonly failures: unknown[] = [];

  constructor(parts: EngineParts) {
    this.#parts = parts;
  }

  async createActor(given: {
    readonly agent: AgentId;
    readonly deployment: DeploymentRef;
    readonly model: string;
    readonly reasoning?: Reasoning;
    readonly configuration?: Json;
    readonly name?: Name;
    readonly externalId?: ExternalId;
  }): Promise<Actor> {
    const { store, clock, entropy } = this.#parts;
    const now = clock();
    const { actor } = await store.createActor({
      id: makeId('actor', { now, random: entropy() }),
      name: given.name ?? null,
      externalId: given.externalId ?? null,
      agent: given.agent,
      deployment: given.deployment,
      model: given.model,
      reasoning: given.reasoning ?? 'medium',
      configuration: given.configuration ?? null,
      status: 'idle',
      lastTurn: null,
      pendingInputs: 0,
      createdAt: now,
      archivedAt: null,
    });
    return actor;
  }

  /** Sends an actor an input. It answers once the input is in the mailbox, not once it is read. */
  async send(
    actorId: ActorId,
    sent: { readonly type: string; readonly payload?: Json; readonly externalId?: ExternalId },
  ): Promise<{ readonly input: InputId; readonly status: 'accepted' | 'duplicate' }> {
    const { store, executor, clock, entropy } = this.#parts;
    const record = await store.loadActor(actorId);
    if (record === undefined) throw new ActorNotFound(`There is no actor ${actorId}`);

    // The agent's own code turns what was sent into what the model reads.
    const handled = await executor.call(
      record.actor.deployment.id,
      `inputs.${sent.type}.handler`,
      sent.payload ?? null,
      this.#contextOf(record),
    );
    if (!handled.ok) throw new InputRefused(handled.error);

    const now = clock();
    const input: Input = {
      id: makeId('input', { now, random: entropy() }),
      actor: actorId,
      type: sent.type,
      externalId: sent.externalId ?? null,
      message: { role: 'user', content: contentOf(handled.value) },
      receivedAt: now,
      deliveredAt: null,
    };
    const status = await store.addInput(input);
    if (status === 'accepted') this.#wake(actorId);
    return { input: input.id, status };
  }

  /** Picks up every actor with something owed: what a process does when it starts. */
  async recover(): Promise<void> {
    for (const id of await this.#parts.store.unfinished()) this.#wake(id, true);
  }

  /** Resolves when this engine is doing nothing for the actor. */
  async settled(actorId: ActorId): Promise<void> {
    for (;;) {
      const drive = this.#driving.get(actorId);
      if (drive === undefined) return;
      await drive;
    }
  }

  #contextOf(record: ActorRecord): CallContext {
    const { actor } = record;
    return { agent: actor.agent, actor: actor.id, configuration: actor.configuration };
  }

  #wake(id: ActorId, recovering = false): void {
    if (this.#driving.has(id)) {
      this.#again.add(id);
      return;
    }
    const drive = this.#drive(id, recovering)
      .catch((error: unknown) => {
        this.failures.push(error);
      })
      .finally(() => {
        this.#driving.delete(id);
        // Mail that came as the drive was ending found the actor still held, and started nothing.
        if (this.#again.delete(id)) this.#wake(id);
      });
    this.#driving.set(id, drive);
  }

  /** Does what the actor is owed, until nothing is. */
  async #drive(id: ActorId, recovering: boolean): Promise<void> {
    const { store, runner } = this.#parts;
    // What was owed when a restart found the actor may have been begun before the restart.
    let cutOff = recovering;
    for (;;) {
      const record = await store.loadActor(id);
      if (record === undefined) return;
      const { turn } = record;

      if (turn.phase === 'idle') {
        const inputs = await store.pendingInputs(id);
        if (inputs.length === 0) return;
        await this.#apply(record, { type: 'wake', inputs });
      } else if (turn.phase === 'model') {
        // A call of the model that was cut off is made again: it changed nothing outside.
        let event: MachineEvent;
        try {
          event = { type: 'answered', answer: await runner.run(await this.#stepOf(record)) };
        } catch (error) {
          event = {
            type: 'model_failed',
            reason: error instanceof Error ? error.message : String(error),
          };
        }
        await this.#apply(record, event);
      } else {
        const owed = turn.calls.filter((call) => call.result === null);
        if (owed.length === 0) {
          await this.#apply(record, { type: 'continue', inputs: await store.pendingInputs(id) });
        } else {
          await this.#runTools(record, owed, cutOff);
        }
      }
      cutOff = false;
    }
  }

  /**
   * Runs the tool calls side by side, and stores each result as it comes, so that a restart
   * loses none that had finished. Each store names the epoch the last one left: they go in one
   * after another, whatever order the tools end in.
   */
  async #runTools(record: ActorRecord, owed: readonly OwedCall[], cutOff: boolean): Promise<void> {
    let current = record;
    let stored: Promise<void> = Promise.resolve();
    await Promise.all(
      owed.map(async (call) => {
        const result = await this.#runTool(record, call, cutOff);
        stored = stored.then(async () => {
          current = await this.#apply(current, { type: 'tool_finished', call: call.id, result });
        });
        await stored;
      }),
    );
  }

  async #runTool(record: ActorRecord, call: OwedCall, cutOff: boolean): Promise<ToolResultMessage> {
    const { executor } = this.#parts;
    const deployment = record.actor.deployment.id;
    const answer = (content: ContentPart[], isError: boolean): ToolResultMessage => ({
      role: 'tool_result',
      toolCallId: call.id,
      toolName: call.name,
      content,
      isError,
    });

    const { tools } = await executor.describe(deployment);
    const tool = tools.find((declared) => declared.name === call.name);
    if (tool === undefined) {
      return answer([{ type: 'text', text: `There is no tool ${call.name}` }], true);
    }
    // The state says the call was owed, not whether it had been begun. One that is safe to make
    // again is made again. One that is not is answered honestly.
    if (cutOff && !tool.retrySafe) {
      const text = `The call of ${call.name} was cut off by a restart. It may or may not have run.`;
      return answer([{ type: 'text', text }], true);
    }

    const result: CallResult = await executor.call(
      deployment,
      `tools.${call.name}.execute`,
      call.arguments,
      this.#contextOf(record),
    );
    return result.ok
      ? answer(contentOf(result.value), false)
      : answer([{ type: 'text', text: result.error }], true);
  }

  /** What the model is called with: the agent's definition, and the conversation so far. */
  async #stepOf(record: ActorRecord): Promise<ModelStep> {
    const { store, executor } = this.#parts;
    const { actor } = record;
    const definition = await executor.describe(actor.deployment.id);
    const conversation = await store.conversation(actor.id);
    return {
      model: actor.model,
      reasoning: actor.reasoning,
      instructions: definition.instructions,
      tools: definition.tools.map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
      messages: conversation
        .filter((entry) => entry.leftOut !== true)
        .map((entry) => entry.message),
    };
  }

  /** Has the machine decide, stores what it decided, and tells whoever follows the actor. */
  async #apply(record: ActorRecord, event: MachineEvent): Promise<ActorRecord> {
    const { store, bus, clock } = this.#parts;
    const change = decide(record, event, clock());
    const next = await store.commit(record.actor.id, record.epoch, change);

    for (const entry of change.append) bus.publish(next.actor.id, { type: 'message', entry });
    const before = record.actor;
    const after = next.actor;
    if (
      before.status !== after.status ||
      before.pendingInputs !== after.pendingInputs ||
      JSON.stringify(before.lastTurn) !== JSON.stringify(after.lastTurn)
    ) {
      bus.publish(after.id, {
        type: 'status',
        status: after.status,
        lastTurn: after.lastTurn,
        pendingInputs: after.pendingInputs,
      });
    }
    return next;
  }
}
