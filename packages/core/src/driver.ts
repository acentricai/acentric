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
import type { ModelStep } from '@acentric/ai';
import { contentPartSchema } from '@acentric/protocol';
import type {
  Actor,
  ActorId,
  AgentDefinition,
  AgentId,
  AssistantMessage,
  ContentPart,
  DeploymentId,
  DeploymentRef,
  Input,
  Json,
  Message,
  Name,
  Reasoning,
  ToolResultMessage,
} from '@acentric/protocol';

import type { Access } from './accounts.ts';
import type { EventBus } from './bus.ts';
import {
  ActorArchived,
  ActorBusy,
  AgentNotFound,
  CodeUnavailable,
  Conflict,
  InvalidConfiguration,
  Unavailable,
} from './errors.ts';
import { contextOf as callContextOf, issuesText } from './executor.ts';
import type { CallContext, CallResult } from './executor.ts';
import type { Semaphore } from './limits.ts';
import { OutOfTurn, decide } from './machine.ts';
import type { MachineEvent, Rules } from './machine.ts';
import { applyChange } from './state.ts';
import type { ActorPatch, ActorRecord, Change, OwedCall, Turn } from './state.ts';
import type { Store } from './store.ts';

/** The time, in milliseconds. */
export type Clock = () => number;

/** Waits `ms` milliseconds, or until `signal` is aborted, whichever is first. */
export type Timer = (ms: number, signal: AbortSignal) => Promise<void>;

/** What a driver is given of the engine it is part of. */
export type Host = {
  readonly store: Store;
  /**
   * What an actor's model is called with: a runner, and the model account it is of, when one
   * says. It rejects, with why, when the model cannot be called at all.
   */
  access(actor: Actor, definition: AgentDefinition): Promise<Access>;
  /** Calls a function of a deployment's code. The code is loaded first, if it is not. */
  call(
    deployment: DeploymentId,
    path: string,
    argument: Json,
    context: CallContext,
    signal: AbortSignal,
  ): Promise<CallResult>;
  readonly bus: EventBus;
  readonly clock: Clock;
  readonly timer: Timer;
  readonly rules: Rules;
  /** How many turns go on at once: a driver holds one of these while its actor is in a turn. */
  readonly slots: Semaphore;
  definition(deployment: DeploymentId): Promise<AgentDefinition>;
  /** The active deployment of an agent. Undefined when there is no such agent. */
  active(agent: AgentId): Promise<DeploymentRef | undefined>;
  /** The deployment of an agent with a version. Undefined when it has none. */
  version(agent: AgentId, version: number): Promise<DeploymentRef | undefined>;
  /** What names the instructions and tools the model is sent for a definition. */
  fingerprint(definition: AgentDefinition): string;
  /** Whether the reasoning of the actor's model is tied to what came before it. */
  bindsReasoning(actor: Actor, definition: AgentDefinition): boolean;
  /** An answer of the definition's provider, without its reasoning. */
  withoutReasoning(definition: AgentDefinition, message: AssistantMessage): AssistantMessage;
  /**
   * The message that changes the reasoning level of the definition's provider from where it
   * is in a conversation, or undefined for a provider that takes a level only with a call.
   */
  reasoningChange(
    definition: AgentDefinition,
    model: string,
    reasoning: Reasoning,
  ): Message | undefined;
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

type Command = {
  readonly run: () => Promise<void>;
  readonly abandon: (error: Error) => void;
  /** Done between turns or not at all: it is refused when a turn starts before it is done. */
  readonly betweenTurns: boolean;
};

/** What of an actor a person changes. */
export type ActorUpdate = {
  readonly name?: Name | null;
  readonly modelId?: string;
  readonly reasoning?: Reasoning;
  readonly configuration?: Json;
  /** A number pins it to that version of its agent. `active` has it follow the active one. */
  readonly version?: number | 'active';
};

/** How an actor fits a deployment: with what configuration, or why it does not. */
type Fit =
  | { readonly ok: true; readonly configuration: Json | null; readonly given: Json | null }
  /** `passing`: it could not be checked just now, which says nothing of whether it fits. */
  | {
      readonly ok: false;
      readonly reason: string;
      readonly error: Error;
      readonly passing: boolean;
    };

/**
 * What a person is refused, which is no failure of the actor's driver: anything that says the
 * code the API answers it with. It is told by that and not by its class, since a store may
 * have been built apart from this engine.
 */
const isRefusal = (error: unknown): boolean =>
  error instanceof Error && typeof (error as { code?: unknown }).code === 'string';

export class ActorDriver {
  /** Where the actor stands, as of the last step that was stored. */
  record: ActorRecord;
  /** What waits in its mailbox, oldest first. */
  mail: Input[];
  /** The driver met something it cannot go on from. Another is made in its place. */
  dead = false;

  readonly #host: Host;
  /**
   * The conversation, but for what was left out of it. Read from the store the first time it
   * is needed.
   */
  #conversation: { readonly seq: number; readonly message: Message }[] | null = null;
  /** The conversation as the model is sent it: without its reasoning from before `from`. */
  #view: { readonly from: number; readonly messages: Message[] } | null = null;
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
    // A driver made after the input was stored read it from the mailbox already.
    if (this.mail.some((waiting) => waiting.id === input.id)) {
      this.wake();
      return;
    }
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
    return this.#command('retry', async () => {
      // A turn that is tried again starts where any turn does: on the deployment it is to be on.
      const set = await this.#follow();
      await this.#apply({ type: 'retry', ...(set === undefined ? {} : { set }) });
    });
  }

  /**
   * Changes what the actor was created with. Only between turns: it is refused at once for an
   * actor in a turn. Nothing is changed when its configuration does not fit.
   */
  update(changes: ActorUpdate): Promise<Actor> {
    const { actor, turn } = this.record;
    if (actor.status === 'archived') return Promise.reject(new ActorArchived(actor.id));
    if (turn.phase !== 'idle') return Promise.reject(new ActorBusy(actor.id));
    const update = async () => {
      const set = await this.#changed(changes);
      const said = await this.#levelChange(set);
      await this.#apply({ type: 'update', set: { ...set, ...said?.set }, ...said?.event });
    };
    return this.#command('update', update, true);
  }

  /** Puts the actor away. A turn it is in is ended first. */
  async archive(): Promise<Actor> {
    // Asked for before the interrupt, so that it is done before any mail starts another turn.
    const archived = this.#command('archive', () => this.#apply({ type: 'archive' }));
    archived.catch(() => {});
    if (this.record.turn.phase !== 'idle') await this.interrupt();
    return archived;
  }

  unarchive(): Promise<Actor> {
    return this.#command('unarchive', () => this.#apply({ type: 'unarchive' }));
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

  /** Has `act` done when the actor is next between turns, and gives the actor as it then is. */
  #command(what: string, act: () => Promise<void>, betweenTurns = false): Promise<Actor> {
    if (this.#host.closing()) return Promise.reject(new Unavailable());
    return new Promise<Actor>((resolve, reject) => {
      this.#commands.push({
        abandon: reject,
        betweenTurns,
        run: async () => {
          try {
            await act();
            resolve(this.record.actor);
          } catch (error) {
            if (error instanceof OutOfTurn) {
              const { status, lastTurn } = this.record.actor;
              const stands = `${status}, its last turn ${lastTurn?.end ?? 'none'}`;
              reject(new Conflict(`The actor cannot ${what} as it stands: ${stands}`));
              return;
            }
            // Whoever asked is told, whatever it was. Only what was no refusal ends the driver.
            reject(error as Error);
            if (!isRefusal(error)) throw error;
          }
        },
      });
      this.wake();
    });
  }

  /**
   * How the actor fits a deployment of its agent. Its configuration as it was given is checked
   * by that deployment's schema, or `given` is when a person gives another. A deployment that
   * takes no configuration drops the one the actor has, and refuses one a person gives.
   */
  async #fit(deployment: DeploymentRef, given?: Json): Promise<Fit> {
    const { actor, configurationGiven } = this.record;
    const refused = (reason: string, issues?: Parameters<typeof issuesText>[0]): Fit => ({
      ok: false,
      passing: false,
      reason,
      error: new InvalidConfiguration(
        `The configuration is not one of version ${String(deployment.version)} of the agent. ${reason}`,
        issues,
      ),
    });
    let definition: AgentDefinition;
    try {
      definition = await this.#host.definition(deployment.id);
    } catch (error) {
      return refused(error instanceof Error ? error.message : String(error));
    }
    if (definition.configuration === null && given === undefined) {
      return { ok: true, configuration: null, given: null };
    }
    const from = given === undefined ? configurationGiven : given;
    const checked = await this.#host.call(
      deployment.id,
      'configuration.validate',
      from,
      { ...callContextOf(actor), configuration: null },
      new AbortController().signal,
    );
    if (checked.ok) return { ok: true, configuration: checked.value, given: from };
    if (checked.kind === 'lost') {
      const error = new CodeUnavailable(checked.reason);
      return { ok: false, passing: true, reason: checked.reason, error };
    }
    return checked.kind === 'invalid'
      ? refused(issuesText(checked.issues), checked.issues)
      : refused(checked.error.message);
  }

  /**
   * What moves the actor to its agent's active deployment as a turn starts, or says why it
   * stays behind. Undefined for an actor that is where it is to be, or is pinned, or was
   * found not to fit that deployment already.
   */
  async #follow(): Promise<ActorPatch | undefined> {
    const { actor } = this.record;
    if (actor.pinned) return undefined;
    const active = await this.#host.active(actor.agent);
    if (active === undefined) return undefined;
    if (active.id === actor.deployment.id) {
      return actor.behind === null ? undefined : { behind: null };
    }
    // The same deployment and the same configuration fit no better the second time.
    if (actor.behind?.deployment.id === active.id) return undefined;
    const fit = await this.#fit(active);
    // Not checked this time: it stays where it is for this turn, and is checked at the next.
    if (!fit.ok && fit.passing) return undefined;
    if (!fit.ok) return { behind: { deployment: active, reason: fit.reason } };
    return {
      deployment: active,
      configuration: fit.configuration,
      configurationGiven: fit.given,
      behind: null,
    };
  }

  /**
   * For a change of the actor's reasoning level, where its provider can change the level from
   * a place in the conversation on: the message that does, for the conversation's end, and the
   * level its calls go on being sent with, which is the one they were sent with so far. So
   * the calls stay as its provider has read them, and what the provider keeps stays good.
   *
   * Undefined when there is nothing to say: the level does not change, the provider takes it
   * only with a call, or its model has not answered yet and there is nothing kept to lose.
   */
  async #levelChange(set: ActorPatch): Promise<
    | {
        readonly set: ActorPatch;
        readonly event: { readonly append: readonly Message[] };
      }
    | undefined
  > {
    const { actor, reasoningSent, sent } = this.record;
    const level = set.reasoning;
    if (level === undefined || level === actor.reasoning || sent === null) return undefined;
    const deployment = set.deployment ?? actor.deployment;
    const definition = await this.#host.definition(deployment.id);
    const model = set.modelId ?? actor.modelId;
    const message = this.#host.reasoningChange(definition, model, level);
    if (message === undefined) return undefined;
    return {
      set: { reasoningSent: reasoningSent ?? actor.reasoning },
      event: { append: [message] },
    };
  }

  /** What a person's changes come to, or a throw that says why they are refused. */
  async #changed(changes: ActorUpdate): Promise<ActorPatch> {
    const { actor } = this.record;
    const { version } = changes;
    let target = actor.deployment;
    if (version !== undefined) {
      const found =
        version === 'active'
          ? await this.#host.active(actor.agent)
          : await this.#host.version(actor.agent, version);
      if (found === undefined) {
        throw new AgentNotFound(actor.agent, version === 'active' ? undefined : version);
      }
      target = found;
    }
    const moves = target.id !== actor.deployment.id;
    let fitted: ActorPatch = {};
    if (moves || changes.configuration !== undefined) {
      const fit = await this.#fit(target, changes.configuration);
      if (!fit.ok) throw fit.error;
      fitted = {
        configuration: fit.configuration,
        configurationGiven: fit.given,
        ...(moves ? { deployment: target } : {}),
      };
    }
    return {
      ...(changes.name === undefined ? {} : { name: changes.name }),
      ...(changes.modelId === undefined ? {} : { modelId: changes.modelId }),
      ...(changes.reasoning === undefined ? {} : { reasoning: changes.reasoning }),
      ...fitted,
      ...(version === undefined ? {} : { pinned: version !== 'active', behind: null }),
    };
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
        // A turn starts on the deployment the actor is to be on, and ends on it.
        const set = await this.#follow();
        await this.#apply(() => ({
          type: 'wake',
          inputs: [...this.mail],
          ...(set === undefined ? {} : { set }),
        }));
        // What was asked for between turns while this one was starting waits for no turn.
        const waiting = this.#commands.filter((queued) => queued.betweenTurns);
        this.#commands = this.#commands.filter((queued) => !queued.betweenTurns);
        for (const queued of waiting) queued.abandon(new ActorBusy(actor.id));
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
    const { clock, timer } = this.#host;
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
      // The call, once one is made: what is written down of it, answered or failed.
      let called:
        | { readonly account: Access['account']; readonly provider: string; readonly at: number }
        | undefined;
      const call = () => {
        if (called === undefined) return {};
        const { account, provider, at } = called;
        return { call: { account, provider, durationMs: clock() - at } };
      };
      try {
        const { step, access, sent, provider } = await this.#step();
        called = { account: access.account, provider, at: clock() };
        const answer = await untilAborted(
          access.runner.run(step, controller.signal),
          controller.signal,
        );
        if (answer === ABORTED) return;
        event = { type: 'answered', answer, sent, ...call() };
      } catch (error) {
        if (controller.signal.aborted) return;
        event =
          error instanceof ModelFailure
            ? {
                type: 'model_failed',
                reason: error.message,
                retryable: error.retryable,
                kind: error.kind,
                ...call(),
                ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
                // Reasoning the engine did not know to leave out: it is left out, once. When
                // none is being sent and the provider still says so, it is a failure like any.
                ...(error.kind === 'stale_reasoning' &&
                this.record.reasoningFrom < this.record.nextSeq
                  ? { staleReasoning: true }
                  : {}),
              }
            : {
                type: 'model_failed',
                reason: error instanceof Error ? error.message : String(error),
                retryable: false,
                ...call(),
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
    const { actor } = this.record;
    const answer = (content: ContentPart[], isError: boolean): ToolResultMessage => ({
      role: 'tool_result',
      toolCallId: call.id,
      toolName: call.name,
      content,
      isError,
      // What the provider needs said again on the result of this call.
      ...(call.resultOptions === undefined ? {} : { providerOptions: call.resultOptions }),
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

    const run = () =>
      this.#host.call(
        actor.deployment.id,
        `tools.${call.name}.execute`,
        call.arguments,
        callContextOf(actor),
        signal,
      );
    let result = await run();
    // What ran the tool died with the call in it, as a restart of the engine would have cut it
    // off: it may or may not have run. One that is safe to make again is made again, once.
    if (!result.ok && result.kind === 'lost' && tool.retrySafe) result = await run();
    if (result.ok) return answer(contentOf(result.value), false);
    if (result.kind === 'lost') {
      const text = `The call of ${call.name} was lost: ${result.reason}. It may or may not have run.`;
      return answer([{ type: 'text', text }], true);
    }
    // The model reads what was wrong with what it gave, and may give it again, right.
    const text =
      result.kind === 'invalid'
        ? `The arguments are not what ${call.name} takes. ${issuesText(result.issues)}`
        : result.error.message;
    return answer([{ type: 'text', text }], true);
  }

  /**
   * What the model is called with: the agent's definition, and the conversation so far.
   *
   * `sent` is what the answer is stored with: what names the instructions and tools of this
   * call, and the place the model's reasoning is sent from. When the instructions or the
   * tools are not those of the last call the model answered, and the model's reasoning is
   * tied to them, none of the reasoning there is so far is sent: its provider would refuse
   * it, or throw it away.
   */
  async #step(): Promise<{
    readonly step: ModelStep;
    readonly access: Access;
    readonly sent: NonNullable<Change['sent']>;
    readonly provider: string;
  }> {
    const { actor, nextSeq } = this.record;
    const definition = await this.#host.definition(actor.deployment.id);
    const fingerprint = this.#host.fingerprint(definition);
    const changed = this.record.sent !== null && this.record.sent !== fingerprint;
    const from =
      changed && this.#host.bindsReasoning(actor, definition) ? nextSeq : this.record.reasoningFrom;

    if (this.#conversation === null) {
      const entries = await this.#host.store.conversation(actor.id);
      this.#conversation = entries
        .filter((entry) => entry.leftOut !== true)
        .map(({ seq, message }) => ({ seq, message }));
      this.#view = null;
    }
    if (this.#view?.from !== from) {
      this.#view = {
        from,
        messages: this.#conversation.map(({ seq, message }) =>
          seq < from && message.role === 'assistant'
            ? this.#host.withoutReasoning(definition, message)
            : message,
        ),
      };
    }
    const step: ModelStep = {
      model: actor.modelId,
      // Where its level was changed in its conversation, the call's own stays what it was.
      reasoning: this.record.reasoningSent ?? actor.reasoning,
      instructions: definition.instructions,
      tools: definition.tools.map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
      messages: [...this.#view.messages],
      // The same at every call of this actor's: a provider finds what it has read of the
      // conversation by it.
      session: actor.id,
      ...(definition.providerOptions === undefined ? {} : { options: definition.providerOptions }),
    };
    return {
      step,
      access: await this.#host.access(actor, definition),
      sent: { fingerprint, reasoningFrom: from },
      provider: definition.provider,
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
        for (const { seq, message, leftOut } of change.append) {
          if (leftOut === true) continue;
          this.#conversation.push({ seq, message });
          // What is new is from after the place reasoning is sent from: it is sent whole.
          this.#view?.messages.push(message);
        }
      } else {
        // Messages already held are left out now: it is read again when it is next needed.
        this.#conversation = null;
        this.#view = null;
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
