// The driver of one actor: it reads where the actor stands, does what is owed, and feeds what
// happened to the machine, until nothing is owed.
//
// While an actor has a driver, the driver holds everything of it the engine needs: its record,
// its mail and its conversation. The store is read once, when the driver is made, and from
// then on only written to. An actor with nothing owed gives its driver up, and is rows in the
// store and nothing else.
//
// In one process an actor has one driver, and a driver does one thing at a time, so no two
// steps of an actor race. The epoch in the store is for what the process cannot see: another
// process that thinks the actor its own.

import { ModelFailure } from '@acentric/ai';
import type { ModelRunner, ModelStep } from '@acentric/ai';
import { contentPartSchema } from '@acentric/protocol';
import type {
  Actor,
  ActorId,
  AgentDefinition,
  ContentPart,
  DeploymentId,
  Input,
  Json,
  Message,
  ToolResultMessage,
} from '@acentric/protocol';

import type { EventBus } from './bus.ts';
import { Conflict, Unavailable } from './errors.ts';
import type { Executor } from './executor.ts';
import type { Semaphore } from './limits.ts';
import { OutOfTurn, decide } from './machine.ts';
import type { MachineEvent, Rules } from './machine.ts';
import { applyChange } from './state.ts';
import type { ActorRecord, OwedCall, Turn } from './state.ts';
import type { Store } from './store.ts';

/** The time, in milliseconds. */
export type Clock = () => number;

/** Waits `ms` milliseconds, or until `signal` is aborted, whichever is first. */
export type Timer = (ms: number, signal: AbortSignal) => Promise<void>;

/** What a driver is given of the engine it is part of. */
export type Host = {
  readonly store: Store;
  readonly runner: ModelRunner;
  readonly executor: Executor;
  readonly bus: EventBus;
  readonly clock: Clock;
  readonly timer: Timer;
  readonly rules: Rules;
  /** How many turns go on at once: a driver holds one of these while its actor is in a turn. */
  readonly slots: Semaphore;
  definition(deployment: DeploymentId): Promise<AgentDefinition>;
  /** Whether the engine is shutting down: nothing new is begun. */
  closing(): boolean;
  report(error: unknown): void;
  /** Called when a driver has stopped: it may have nothing left to do. */
  rested(driver: ActorDriver): void;
};

type ModelTurn = Extract<Turn, { phase: 'model' }>;
type ToolsTurn = Extract<Turn, { phase: 'tools' }>;

const ABORTED = Symbol('aborted');

/** What `promise` comes to, or `ABORTED` when `signal` is aborted first. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.resolve(ABORTED);
  }
  return new Promise((resolve, reject) => {
    const aborted = () => {
      resolve(ABORTED);
    };
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', aborted);
        // After an abort nobody waits for this: it is not a failure of anything.
        if (!signal.aborted) reject(error as Error);
      },
    );
  });
}

/** What a function of an agent returned, as content: text as it is, anything else as JSON. */
export function contentOf(value: Json): ContentPart[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  const parts = contentPartSchema.array().safeParse(value);
  return parts.success ? parts.data : [{ type: 'text', text: JSON.stringify(value) }];
}

type Command = { readonly run: () => Promise<void>; readonly abandon: (error: Error) => void };

export class ActorDriver {
  /** Where the actor stands, as of the last step that was stored. */
  record: ActorRecord;
  /** What waits in its mailbox, oldest first. */
  mail: Input[];
  /** The driver met something it cannot go on from. Another is made in its place. */
  dead = false;

  readonly #host: Host;
  /** The conversation as the model is sent it. Read from the store the first time it is needed. */
  #conversation: Message[] | null = null;
  #running: Promise<void> | null = null;
  /** Something came while the driver was running: it looks once more before it stops. */
  #woken = false;
  /** A restart found the actor as it stands: what is owed may have been begun before it. */
  #recovering = false;
  #interrupt = false;
  #interrupted: (() => void)[] = [];
  /** What stops the call or the wait the driver is in. */
  #abort: AbortController | null = null;
  #inTimer = false;
  #held = false;
  #commands: Command[] = [];
  #applying: Promise<unknown> = Promise.resolve();

  constructor(host: Host, record: ActorRecord, mail: Input[]) {
    this.#host = host;
    this.record = record;
    this.mail = mail;
  }

  get id(): ActorId {
    return this.record.actor.id;
  }

  /** Whether it is doing something now. */
  get running(): boolean {
    return this.#running !== null;
  }

  /** Whether it has nothing to do, and nothing waits for it. */
  get resting(): boolean {
    const { actor, turn } = this.record;
    return (
      this.#running === null &&
      this.#commands.length === 0 &&
      turn.phase === 'idle' &&
      (this.mail.length === 0 || actor.status !== 'idle')
    );
  }

  /** An input the store has taken: it starts a turn, or joins the one going on. */
  receive(input: Input): void {
    this.mail.push(input);
    this.record = {
      ...this.record,
      actor: { ...this.record.actor, pendingInputs: this.mail.length },
    };
    this.#publishStatus();
    this.wake();
  }

  /** Has the driver look at what is owed. `recovering` when a restart found the actor. */
  wake(recovering = false): void {
    if (recovering) this.#recovering = true;
    this.#woken = true;
    if (this.#running !== null || this.dead) return;
    this.#running = this.#loop()
      .catch((error: unknown) => {
        this.dead = true;
        this.abandon(error instanceof Error ? error : new Error(String(error)));
        this.#host.report(error);
      })
      .finally(() => {
        this.#running = null;
        // Something that came after the loop last looked, and before it was known to have
        // stopped, found the driver still held and started nothing. It is looked at now.
        if (this.#woken && !this.dead && !this.#host.closing()) this.wake();
        else this.#host.rested(this);
      });
  }

  /** Resolves when the driver is doing nothing. */
  async settled(): Promise<void> {
    while (this.#running !== null) await this.#running;
  }

  /** Ends the turn the actor is in. Resolves once it has ended, with the actor as it then stands. */
  async interrupt(): Promise<Actor> {
    if (this.record.turn.phase === 'idle' && this.#running === null) return this.record.actor;
    const ended = new Promise<void>((resolve) => this.#interrupted.push(resolve));
    this.#interrupt = true;
    this.#abort?.abort();
    this.wake();
    await ended;
    return this.record.actor;
  }

  retry(): Promise<Actor> {
    return this.#command({ type: 'retry' });
  }

  /** Puts the actor away. A turn it is in is ended first. */
  async archive(): Promise<Actor> {
    // Asked for before the interrupt, so that it is done before any mail starts another turn.
    const archived = this.#command({ type: 'archive' });
    archived.catch(() => {});
    if (this.record.turn.phase !== 'idle') await this.interrupt();
    return archived;
  }

  unarchive(): Promise<Actor> {
    return this.#command({ type: 'unarchive' });
  }

  /** The engine is shutting down: a wait for a later try is given up, a call goes on. */
  drain(): void {
    if (this.#inTimer) this.#abort?.abort();
  }

  /** The engine has waited long enough: whatever the driver is in is given up, and stays owed. */
  halt(): void {
    this.#abort?.abort();
  }

  /** Refuses whatever waits for the driver to do something it now will not. */
  abandon(error: Error): void {
    for (const command of this.#commands.splice(0)) command.abandon(error);
    for (const resolve of this.#interrupted.splice(0)) resolve();
  }

  #command(event: MachineEvent): Promise<Actor> {
    if (this.#host.closing()) return Promise.reject(new Unavailable());
    return new Promise<Actor>((resolve, reject) => {
      this.#commands.push({
        abandon: reject,
        run: async () => {
          try {
            await this.#apply(event);
            resolve(this.record.actor);
          } catch (error) {
            if (!(error instanceof OutOfTurn)) throw error;
            const { status, lastTurn } = this.record.actor;
            const stands = `${status}, its last turn ${lastTurn?.end ?? 'none'}`;
            reject(new Conflict(`The actor cannot ${event.type} as it stands: ${stands}`));
          }
        },
      });
      this.wake();
    });
  }

  async #loop(): Promise<void> {
    try {
      do {
        this.#woken = false;
        await this.#work();
      } while (this.#woken && !this.#host.closing());
    } finally {
      this.#release();
    }
  }

  /** Does what the actor is owed, until nothing is. */
  async #work(): Promise<void> {
    for (;;) {
      if (this.#host.closing()) return;
      const cutOff = this.#recovering;
      this.#recovering = false;
      const { turn, actor } = this.record;

      if (turn.phase === 'idle') {
        this.#interruptDone();
        const command = this.#commands.shift();
        if (command !== undefined) {
          await command.run();
          continue;
        }
        if (actor.status !== 'idle' || this.mail.length === 0) return;
        if (!(await this.#hold())) return;
        await this.#apply(() => ({ type: 'wake', inputs: [...this.mail] }));
        continue;
      }

      if (!(await this.#hold())) return;
      if (this.#interrupt) {
        await this.#apply({ type: 'interrupted' });
        this.#interruptDone();
        continue;
      }
      if (turn.phase === 'model') await this.#model(turn, cutOff);
      else await this.#tools(turn, cutOff);
    }
  }

  #interruptDone(): void {
    this.#interrupt = false;
    for (const resolve of this.#interrupted.splice(0)) resolve();
  }

  /** Takes one of the engine's turns, if it has none. False when the engine is shutting down. */
  async #hold(): Promise<boolean> {
    if (this.#held) return true;
    this.#held = await this.#host.slots.acquire();
    return this.#held;
  }

  #release(): void {
    if (!this.#held) return;
    this.#held = false;
    this.#host.slots.release();
  }

  async #model(turn: ModelTurn, cutOff: boolean): Promise<void> {
    const { clock, timer, runner } = this.#host;
    // A call that was waiting for its next try was not under way: there is nothing to count.
    const waiting = turn.retryAt !== null && turn.retryAt > clock();
    if (cutOff && !waiting) {
      await this.#apply({ type: 'cut_off' });
      return;
    }

    const controller = new AbortController();
    this.#abort = controller;
    try {
      if (turn.retryAt !== null) {
        const wait = turn.retryAt - clock();
        if (wait > 0) {
          this.#inTimer = true;
          await timer(wait, controller.signal);
          this.#inTimer = false;
        }
        if (controller.signal.aborted) return;
      }

      let event: MachineEvent;
      try {
        const step = await this.#step();
        const answer = await untilAborted(runner.run(step, controller.signal), controller.signal);
        if (answer === ABORTED) return;
        event = { type: 'answered', answer };
      } catch (error) {
        if (controller.signal.aborted) return;
        event =
          error instanceof ModelFailure
            ? {
                type: 'model_failed',
                reason: error.message,
                retryable: error.retryable,
                ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
              }
            : {
                type: 'model_failed',
                reason: error instanceof Error ? error.message : String(error),
                retryable: false,
              };
      }
      // An interrupt that came with the answer wins: the call is dropped.
      if (this.#interrupt) return;
      await this.#apply(event);
    } finally {
      this.#inTimer = false;
      this.#abort = null;
    }
  }

  /**
   * Runs the tool calls that are owed side by side, and stores each result as it comes, so
   * that a restart loses none that had finished.
   */
  async #tools(turn: ToolsTurn, cutOff: boolean): Promise<void> {
    const controller = new AbortController();
    this.#abort = controller;
    try {
      await Promise.all(
        turn.calls
          .filter((call) => call.result === null)
          .map(async (call) => {
            const { signal } = controller;
            const result = await untilAborted(this.#runTool(call, cutOff, signal), signal);
            if (result === ABORTED || this.#interrupt) return;
            await this.#apply(() => ({
              type: 'tool_finished',
              call: call.id,
              result,
              inputs: [...this.mail],
            }));
          }),
      );
    } finally {
      this.#abort = null;
    }
  }

  async #runTool(call: OwedCall, cutOff: boolean, signal: AbortSignal): Promise<ToolResultMessage> {
    const { executor } = this.#host;
    const { actor } = this.record;
    const answer = (content: ContentPart[], isError: boolean): ToolResultMessage => ({
      role: 'tool_result',
      toolCallId: call.id,
      toolName: call.name,
      content,
      isError,
    });

    const { tools } = await this.#host.definition(actor.deployment.id);
    const tool = tools.find((declared) => declared.name === call.name);
    if (tool === undefined) {
      return answer([{ type: 'text', text: `There is no tool ${call.name}` }], true);
    }
    // Every call the state owes was begun as soon as the state was stored, so one a restart
    // finds owed may have run. One that is safe to make again is made again. One that is not
    // is answered with what is known.
    if (cutOff && !tool.retrySafe) {
      const text = `The call of ${call.name} was cut off by a restart. It may or may not have run.`;
      return answer([{ type: 'text', text }], true);
    }

    const result = await executor.call(
      actor.deployment.id,
      `tools.${call.name}.execute`,
      call.arguments,
      { agent: actor.agent, actor: actor.id, configuration: actor.configuration },
      signal,
    );
    return result.ok
      ? answer(contentOf(result.value), false)
      : answer([{ type: 'text', text: result.error }], true);
  }

  /** What the model is called with: the agent's definition, and the conversation so far. */
  async #step(): Promise<ModelStep> {
    const { actor } = this.record;
    const definition = await this.#host.definition(actor.deployment.id);
    if (this.#conversation === null) {
      const entries = await this.#host.store.conversation(actor.id);
      this.#conversation = entries
        .filter((entry) => entry.leftOut !== true)
        .map((entry) => entry.message);
    }
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
      messages: [...this.#conversation],
    };
  }

  /**
   * Has the machine decide, stores what it decided, and only then takes it as so. Steps go one
   * after another, each from where the last left the actor, whatever order they were asked in.
   */
  #apply(event: MachineEvent | (() => MachineEvent)): Promise<void> {
    const applied = this.#applying.then(() => this.#applyNow(event));
    this.#applying = applied.catch(() => {});
    return applied;
  }

  async #applyNow(given: MachineEvent | (() => MachineEvent)): Promise<void> {
    const { store, bus, clock, rules } = this.#host;
    const event = typeof given === 'function' ? given() : given;
    const before = this.record;
    const change = decide(before, event, clock(), rules);
    await store.commit(before.actor.id, before.epoch, change);

    if (change.deliver.length > 0) {
      const taken = new Set(change.deliver);
      this.mail = this.mail.filter((input) => !taken.has(input.id));
    }
    this.record = applyChange(before, change, this.mail.length);
    if (this.#conversation !== null) {
      if (change.leaveOutFrom === null) {
        for (const entry of change.append) {
          if (entry.leftOut !== true) this.#conversation.push(entry.message);
        }
      } else {
        // Messages already held are left out now: it is read again when it is next needed.
        this.#conversation = null;
      }
    }

    for (const entry of change.append) bus.publish(before.actor.id, { type: 'message', entry });
    const was = before.actor;
    const is = this.record.actor;
    if (
      was.status !== is.status ||
      was.pendingInputs !== is.pendingInputs ||
      was.lastTurn !== is.lastTurn
    ) {
      this.#publishStatus();
    }
    if (this.record.turn.phase === 'idle') this.#release();
  }

  #publishStatus(): void {
    const { id, status, lastTurn, pendingInputs } = this.record.actor;
    this.#host.bus.publish(id, { type: 'status', status, lastTurn, pendingInputs });
  }
}
