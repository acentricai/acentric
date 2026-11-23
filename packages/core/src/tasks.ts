// Tasks: work an actor's model started that may go on after the call that started it. This is
// what every kind of task shares. A kind says how its work is run and stopped; everything about
// waiting for it, letting go of it, and telling the model how it ended is here.
//
// A task is attached while the call that started it still waits for it, and its ending is then
// that call's result. It detaches when the call asks for that (a wait of 0), when its wait runs
// out, or when a person's message arrives and the task is past the floor. A detached task goes
// on, and its ending reaches the model as a notice: a message in the actor's mailbox, which
// wakes the actor. Nothing is stopped by detaching.
//
// An ending is told to the model once: as its call's result, as the answer of the `stop` that
// ended it, or as a notice.
//
// A task is stored before its work starts, and its ending is stored with its notice in one
// step. After a restart every running task is watched again: a kind's `run` is written to be
// called again for a task that is under way.

import type {
  Actor,
  ActorId,
  AgentDefinition,
  ContentPart,
  ImagePart,
  Input,
  InputId,
  Json,
  JsonObject,
  SystemMessage,
  Task,
  TaskDetail,
  TaskStoppedBy,
  TextPart,
} from '@acentric/protocol';

import { EngineError } from './errors.ts';
import type { Store, StoredTask, TaskEnding } from './store.ts';

/** How a task's work ended, as its kind tells it. */
export type TaskEnd = {
  /** `done` whatever the work's own outcome was; `failed` when it could not be done at all; `lost` when what ran it is gone. */
  readonly status: 'done' | 'failed' | 'lost';
  /** What the model is told of it: its output, or what it returned. */
  readonly text: string;
  /**
   * Images the model is shown with it, each where `imageMark` of its index stands in `text`:
   * at most `TASK_IMAGES`. A kind that gives images has the rest of its text `unmarked`.
   */
  readonly images?: readonly ImagePart[];
  /** What went wrong that the model is not told, for whoever follows the actor: kept with its notice. */
  readonly problem?: string;
  /**
   * What the model is told of it in no more than `most` characters, when the kind has its own
   * way to cut it. Without it, the end of `text` is kept.
   */
  readonly render?: (most: number) => string;
  /**
   * Set when the work was stopped and it is the kind that knows by what: at its timeout, for a
   * kind that keeps its own, or by a stop the engine no longer remembers asking for, which
   * only a person's can be.
   */
  readonly stoppedBy?: 'timeout' | 'person';
};

/** A task, as its kind is given it. */
export type TaskWork = {
  readonly actor: ActorId;
  readonly id: string;
  readonly input: Json;
  readonly startedAt: number;
};

/** A tool the engine itself offers a model, as the model is told of it. */
export type EngineTool = {
  readonly type: 'function';
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;
};

/**
 * One kind of task. `run` does the work, or goes on watching work that is under way: it is
 * called when a task starts, and again after a restart for a task that had not ended.
 */
export type TaskKind = {
  readonly kind: string;
  /** The letter its tasks' IDs start with. */
  readonly prefix: string;
  /** The tool the model starts one with. `wait` and `timeout` are added to its parameters. */
  readonly tool: {
    readonly name: string;
    readonly description: string;
    /** The JSON Schema properties of its own arguments, and which of them are required. */
    readonly properties: JsonObject;
    readonly required?: readonly string[];
  };
  /** The tool's description for an actor, when it is not the same for every one. */
  describe?(actor: Actor, definition: AgentDefinition | undefined): string;
  /** Lets go of whatever the kind holds, when the engine is going away. */
  close?(): Promise<void>;
  /** Whether an actor can start one, by itself and by what its agent says it is. Every actor can without it. */
  available?(actor: Actor, definition: AgentDefinition | undefined): boolean;
  /**
   * Checks the arguments the model gave, and returns what a task is started with. Throws what
   * is wrong with them. `timeout`, in seconds, is given to a kind that keeps its own.
   */
  input(args: JsonObject, actor: Actor, limits: { readonly timeout?: number }): Json;
  /**
   * The kind stops its own work at the timeout, and says so in how the work ended. Without
   * it, the engine does, which holds only while the engine runs.
   */
  readonly timesOut?: boolean;
  /** How long its work has to stop when told to, in place of the engine's own time. */
  readonly stopGraceMs?: number;
  /**
   * Its tasks are never waited for: the tool takes no `wait` and no `timeout`, and its call is
   * answered as soon as the task is stored.
   */
  readonly alone?: boolean;
  /** How the call that started a task nothing waits for is answered, before the task's ID. */
  started?(task: TaskWork): string;
  /** How a task stands while it runs, in place of how long it has run: such as when it will fire. */
  standing?(task: TaskWork): string;
  /** A line that names a task in its notice, such as how its command starts. */
  title?(input: Json): string;
  /** Where the model can look at the work while it runs, such as `log <path>`. */
  where?(task: TaskWork): string | undefined;
  /**
   * Resolves with how the work ended. When `stop` fires, the work is to be stopped, and this
   * resolves with what there is of it so far. When `closing` fires, the engine is going away:
   * the work is left as it is, and what this does next does not matter.
   */
  run(
    task: TaskWork,
    signals: { readonly stop: AbortSignal; readonly closing: AbortSignal },
  ): Promise<TaskEnd>;
};

export class TaskNotFound extends EngineError {
  override readonly name = 'TaskNotFound';
  readonly code = 'not_found';
  constructor(actor: string, task: string) {
    super(`The actor ${actor} has no task ${task}`);
  }
}

/** What a tool call is answered with. */
export type Answer = {
  readonly text: string;
  /** The same with its images in their places, when it has any: `text` then names each one. */
  readonly content?: readonly (TextPart | ImagePart)[];
  readonly isError?: boolean;
};

export type TaskTimes = {
  /** How long a call waits for its task when it does not say, in milliseconds. */
  readonly defaultWaitMs: number;
  /** How old a task is before a person's message detaches it, in milliseconds. */
  readonly floorMs: number;
  /** How long a task that was told to stop is given before it is taken as stopped. */
  readonly stopGraceMs: number;
};

export const DEFAULT_TASK_TIMES: TaskTimes = {
  defaultWaitMs: 60_000,
  floorMs: 10_000,
  stopGraceMs: 5000,
};

/** The most of a task's result a tool result carries, and a notice. More is cut to its end. */
export const RESULT_CHARS = 20_000;
export const NOTICE_CHARS = 2000;

/** The most images a task's result carries. */
export const TASK_IMAGES = 5;

/** The type of the input a notice is: the engine's own, which no agent's code is run for. */
export const NOTICE = 'notice';

/** The longest a timer is set for: what one can hold. */
const LONGEST_TIMER_MS = 2_000_000_000;

// An image's place in a task's text is one character, so that a cut keeps it or leaves it out whole.
const FIRST_MARK = 0xe0_00;
const MARKS = new RegExp(
  `[\\u${FIRST_MARK.toString(16)}-\\u${(FIRST_MARK + TASK_IMAGES - 1).toString(16)}]`,
  'g',
);

/** What stands in a task's text where the image of this index is. */
export function imageMark(index: number): string {
  if (!(index >= 0 && index < TASK_IMAGES)) {
    throw new RangeError(`A task has at most ${String(TASK_IMAGES)} images`);
  }
  return String.fromCodePoint(FIRST_MARK + index);
}

/** Text with nothing in it that would be taken for an image's place. */
export function unmarked(text: string): string {
  return text.replace(MARKS, '�');
}

/** A task's text with each image named, for whoever reads it as text. */
function named(text: string, images: readonly ImagePart[]): string {
  return images.length === 0 ? text : text.replace(MARKS, '[image]');
}

/** A task's result as cut, with a line for each image whose place was cut away with the text around it. */
function withLeftOut(text: string, images: readonly ImagePart[]): string {
  if (images.length === 0) return text;
  const left = images.length - new Set(text.match(MARKS)).size;
  if (left === 0) return text;
  const what = left === 1 ? 'an image' : `${String(left)} images`;
  return `${text}\n[${what} left out with the text around ${left === 1 ? 'it' : 'them'}]`;
}

/** A task's text with its images in their places. */
function contentOf(
  text: string,
  images: readonly ImagePart[],
): (TextPart | ImagePart)[] | undefined {
  if (images.length === 0) return undefined;
  const content: (TextPart | ImagePart)[] = [];
  let from = 0;
  for (const mark of text.matchAll(MARKS)) {
    const image = images[(mark[0].codePointAt(0) ?? FIRST_MARK) - FIRST_MARK];
    const before = text.slice(from, mark.index);
    if (before !== '') content.push({ type: 'text', text: before });
    from = mark.index + 1;
    if (image !== undefined) content.push(image);
  }
  const rest = text.slice(from);
  if (rest !== '') content.push({ type: 'text', text: rest });
  return content;
}

/** The last `most` characters of `text`, with a line that says how much was left out. */
export function tail(text: string, most: number): string {
  if (text.length <= most) return text;
  return `[… ${String(text.length - most)} earlier characters left out]\n${text.slice(-most)}`;
}

/** A length of time as a person says it: 850ms, 12s, 6m12s, 2h05m. */
export function span(ms: number): string {
  if (ms < 1000) return `${String(Math.max(0, Math.round(ms)))}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${String(Math.floor(minutes / 60))}h${String(minutes % 60).padStart(2, '0')}m`;
}

function workOf(task: StoredTask): TaskWork {
  return { actor: task.actor, id: task.id, input: task.input, startedAt: task.startedAt };
}

/** A task as the API gives it. */
export function infoOf(task: StoredTask): Task {
  return {
    id: task.id,
    kind: task.kind,
    status: task.status,
    ...(task.stoppedBy === null ? {} : { stoppedBy: task.stoppedBy }),
    attached: task.attached,
    startedAt: task.startedAt,
    ...(task.endedAt === null ? {} : { endedAt: task.endedAt }),
  };
}

/** What stopped a task, in words. */
function stopperOf(by: TaskStoppedBy | null, ranMs: number): string {
  if (by === 'timeout') return `[stopped: timed out after ${span(ranMs)}]`;
  if (by === 'person') return `[stopped by a person after ${span(ranMs)}]`;
  if (by === 'abort') return `[stopped after ${span(ranMs)}: the actor was aborted]`;
  return `[stopped after ${span(ranMs)}]`;
}

/** How long an ended task ran. */
const ranOf = (task: StoredTask): number => (task.endedAt ?? task.startedAt) - task.startedAt;

/** How an ended task's result reads: all of it that a call's answer carries, or what a notice does. */
function resultOf(task: StoredTask, most: number): string {
  // A kind that cut its own result stored it both ways, and neither is cut again.
  let text: string;
  if (task.summary === null) text = tail(task.result ?? '', most);
  else text = most < RESULT_CHARS ? task.summary : (task.result ?? '');
  if (task.status !== 'stopped') return text;
  const stopper = stopperOf(task.stoppedBy, ranOf(task));
  return text === '' ? stopper : `${text}\n${stopper}`;
}

/** A call's answer of what a task came to: the text, and the task's images in their places in it. */
function answerOf(task: StoredTask, text: string): Answer {
  const told = withLeftOut(text, task.images);
  const content = contentOf(told, task.images);
  return { text: named(told, task.images), ...(content === undefined ? {} : { content }) };
}

/** The message that tells the model a detached task ended. */
function noticeOf(task: StoredTask, title: string | undefined, problem?: string): SystemMessage {
  const by = task.stoppedBy === null ? '' : ` by="${task.stoppedBy}"`;
  const result = withLeftOut(resultOf(task, NOTICE_CHARS), task.images);
  const head = title === undefined ? undefined : unmarked(title);
  let body = result;
  if (head !== undefined) body = result === '' ? head : `${head}\n${result}`;
  const text = `<task id="${task.id}" kind="${task.kind}" status="${task.status}"${by} ran="${span(ranOf(task))}">\n${body}\n</task>`;
  return {
    role: 'system',
    content: contentOf(text, task.images) ?? [{ type: 'text', text }],
    metadata: {
      notice: {
        task: task.id,
        kind: task.kind,
        status: task.status,
        ...(problem === undefined ? {} : { problem }),
      },
    },
  };
}

/** What the engine's side of a running task is, in this process. */
type Running = {
  /** Fires to have the work stopped. */
  readonly stop: AbortController;
  /** What asked for the stop, once something has. */
  stoppedBy?: TaskStoppedBy;
  /** Its ending is not to start a turn: its notice waits for one that something else starts. */
  quiet?: boolean;
  /** Resolves once the ending is stored, or the engine is going away. */
  settled: Promise<void>;
  timer?: NodeJS.Timeout;
};

export type TasksOptions = {
  readonly store: Store;
  readonly kinds?: readonly TaskKind[];
  readonly times?: Partial<TaskTimes>;
  readonly clock?: () => number;
  /** Makes the ID of the input a notice is. */
  readonly inputId: (now: number) => InputId;
  /** Content as it is kept in an actor's conversation: its images out of it (see `blobs.ts`). */
  readonly keep?: (actor: ActorId, content: ContentPart[]) => Promise<ContentPart[]>;
  readonly report?: (error: unknown) => void;
};

/** What a call that waits for its task is given by whoever makes the call. */
export type Waiting = {
  /** Fires when the call is given up: its turn was ended. The task goes on. */
  readonly signal: AbortSignal;
  /** Whether a message waits in the actor's mailbox that a call lets go of its task for. */
  readonly hasUserMail: () => boolean;
};

export class Tasks {
  readonly #store: Store;
  readonly #kinds: readonly TaskKind[];
  readonly #times: TaskTimes;
  readonly #clock: () => number;
  readonly #inputId: (now: number) => InputId;
  readonly #keep: (actor: ActorId, content: ContentPart[]) => Promise<ContentPart[]>;
  readonly #report: (error: unknown) => void;
  readonly #running = new Map<string, Running>();
  /** Who waits to hear that an actor got mail, or that one of its tasks changed. */
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly #closing = new AbortController();
  /** Puts a notice that was stored in front of its actor. Set by the engine. */
  #deliver: (notice: Input) => void = () => {};
  #stopAgent: ((actor: ActorId, name: string) => Promise<Answer | undefined>) | undefined;

  constructor(options: TasksOptions) {
    this.#store = options.store;
    this.#kinds = options.kinds ?? [];
    this.#times = { ...DEFAULT_TASK_TIMES, ...options.times };
    this.#clock = options.clock ?? Date.now;
    this.#inputId = options.inputId;
    this.#keep = options.keep ?? (async (_actor, content) => content);
    this.#report =
      options.report ??
      ((error) => {
        console.error(error);
      });
  }

  /** How `stop` stops a subagent, by the name its actor gave it. Undefined when it has none of that name. */
  onStopAgent(stop: (actor: ActorId, name: string) => Promise<Answer | undefined>): void {
    this.#stopAgent = stop;
  }

  /** How an actor is given a notice that was put in its mailbox. */
  onNotice(deliver: (notice: Input) => void): void {
    this.#deliver = deliver;
  }

  /**
   * The tools an actor's model has for tasks: one to start each kind the actor can start, and
   * `stop`. None for an actor that can start none.
   */
  tools(actor: Actor, definition?: AgentDefinition): EngineTool[] {
    const subagents = (definition?.subagents ?? []).length > 0;
    const kinds = this.#kinds.filter((kind) => kind.available?.(actor, definition) ?? true);
    if (kinds.length === 0) return [];
    const waitAndTimeout = {
      wait: {
        type: 'number',
        description: `How many seconds this call waits for the result. ${String(this.#times.defaultWaitMs / 1000)} without it. When it runs out nothing is stopped: the task goes on, and you are told when it ends. 0 starts it without waiting.`,
      },
      timeout: {
        type: 'number',
        description:
          'How many seconds it may run before it is stopped. Without it, it has no limit.',
      },
    };
    return [
      ...kinds.map((kind): EngineTool => ({
        type: 'function',
        name: kind.tool.name,
        description: kind.describe?.(actor, definition) ?? kind.tool.description,
        parameters: {
          type: 'object',
          properties: {
            ...kind.tool.properties,
            // A kind that is never waited for takes neither.
            ...(kind.alone === true ? {} : waitAndTimeout),
          },
          required: [...(kind.tool.required ?? [])],
        },
      })),
      {
        type: 'function',
        name: 'stop',
        description: `Stops a task that is running, by its ID, and answers with how it ended. You are not told of its ending again.${
          subagents
            ? ' With the name of one of your subagents, it stops the subagent: its turn is interrupted, its tasks are stopped and so are its own subagents. It is not gone: it is idle, and can be sent more.'
            : ''
        }`,
        parameters: {
          type: 'object',
          properties: {
            task: {
              type: 'string',
              description: subagents
                ? 'The ID of the task, such as "b3", or the name of the subagent.'
                : 'The ID of the task, such as "b3".',
            },
          },
          required: ['task'],
        },
      },
    ];
  }

  /** Whether a tool of this name is one of the tasks' own. */
  handles(toolName: string): boolean {
    return (
      this.#kinds.length > 0 &&
      (toolName === 'stop' || this.#kinds.some((kind) => kind.tool.name === toolName))
    );
  }

  /** An actor's tasks, newest first. `running` gives only those under way. */
  async list(actor: ActorId, options: { readonly running?: boolean } = {}): Promise<Task[]> {
    return (await this.#store.listTasks(actor, options)).map(infoOf);
  }

  /** One task of an actor, with what it was started with and all it came to. */
  async get(actor: ActorId, id: string): Promise<TaskDetail> {
    const task = await this.#store.loadTask(actor, id);
    if (task === undefined) throw new TaskNotFound(actor, id);
    return {
      ...infoOf(task),
      input: task.input,
      result: task.result === null ? null : named(task.result, task.images),
    };
  }

  /**
   * An actor's running tasks, a line each, for telling its model again what is still going
   * on: the ID, the kind, how it stands, what it is, and where to look at it.
   */
  async describe(actor: ActorId): Promise<string[]> {
    const tasks = await this.#store.listTasks(actor, { running: true });
    return tasks.toReversed().map((task) => {
      const kind = this.#kindOf(task);
      const work = workOf(task);
      return [
        `${task.id} ${task.kind}`,
        kind?.standing?.(work) ?? `running ${span(this.#clock() - task.startedAt)}`,
        ...[kind?.title?.(work.input), kind?.where?.(work)].filter((part) => part !== undefined),
      ].join(' · ');
    });
  }

  /** Whether an actor has a task under way. */
  async busy(actor: ActorId): Promise<boolean> {
    return (await this.#store.listTasks(actor, { running: true })).length > 0;
  }

  /** Tells the calls of an actor that wait that something arrived for it. */
  mailArrived(actor: ActorId): void {
    for (const listener of this.#listeners.get(actor) ?? []) listener();
  }

  /**
   * Answers a call of one of the tasks' tools. Undefined when the call was given up, or the
   * engine is going away, before there is an answer: the call is then made again, and finds
   * its task.
   */
  async call(
    actor: Actor,
    call: { readonly id: string; readonly name: string; readonly args: JsonObject },
    waiting: Waiting,
    definition?: AgentDefinition,
  ): Promise<Answer | undefined> {
    if (call.name === 'stop') {
      const { task } = call.args;
      if (typeof task !== 'string' || task === '') {
        return { text: 'stop takes `task`, the ID of a task', isError: true };
      }
      return this.#stopForModel(actor.id, task);
    }
    const kind = this.#kinds.find((one) => one.tool.name === call.name);
    if (kind === undefined || kind.available?.(actor, definition) === false) {
      return { text: `There is no tool ${call.name}`, isError: true };
    }

    // Made again after a restart, a call finds the task it started.
    let task = await this.#store.taskOfCall(actor.id, call.id);
    if (task === undefined) {
      // A kind that is never waited for has its own arguments alone, and is let go of at once.
      let wait: Json | undefined = 0;
      let timeout: Json | undefined;
      let own: JsonObject = call.args;
      if (kind.alone !== true) ({ wait, timeout, ...own } = call.args);
      for (const [name, value] of [
        ['wait', wait],
        ['timeout', timeout],
      ] as const) {
        if (value !== undefined && (typeof value !== 'number' || !(value >= 0))) {
          return { text: `${name} is a number of seconds, 0 or more`, isError: true };
        }
      }
      if (timeout === 0) return { text: 'timeout is more than 0 seconds', isError: true };
      let input: Json;
      try {
        input = kind.input(own, actor, timeout === undefined ? {} : { timeout: timeout as number });
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        return { text: `The arguments of ${call.name} are not valid: ${why}`, isError: true };
      }
      const waitMs = wait === undefined ? this.#times.defaultWaitMs : (wait as number) * 1000;
      const now = this.#clock();
      task = await this.#store.startTask({
        actor: actor.id,
        kind: kind.kind,
        prefix: kind.prefix,
        input,
        callId: call.id,
        attached: waitMs > 0,
        waitUntil: waitMs > 0 ? now + waitMs : null,
        timeoutAt: timeout === undefined ? null : now + (timeout as number) * 1000,
        startedAt: now,
      });
      this.#watch(task);
      if (!task.attached) {
        const lead = kind.started?.(workOf(task)) ?? 'running in the background';
        return { text: this.#handle(task, lead) };
      }
    } else if (task.status === 'running') {
      this.#watch(task);
    }
    return this.#await(actor.id, task.id, waiting);
  }

  /** Stops a task from outside. Resolves with the task once it has ended. */
  async stop(actor: ActorId, id: string): Promise<Task> {
    const task = await this.#store.loadTask(actor, id);
    if (task === undefined) throw new TaskNotFound(actor, id);
    if (task.status === 'running') await this.#stop(task, 'person');
    const after = await this.#store.loadTask(actor, id);
    if (after === undefined) throw new TaskNotFound(actor, id);
    return infoOf(after);
  }

  /**
   * Stops every task of an actor that is running, for an abort of the actor. Their endings
   * are told as notices that start no turn. Resolves with the tasks once each has ended.
   */
  async stopAll(actor: ActorId): Promise<Task[]> {
    const tasks = (await this.#store.listTasks(actor, { running: true })).toReversed();
    await Promise.all(tasks.map((task) => this.#stop(task, 'abort', true)));
    const after = await Promise.all(tasks.map((task) => this.#store.loadTask(actor, task.id)));
    return after.flatMap((task) => (task === undefined ? [] : [infoOf(task)]));
  }

  /**
   * Lets go of the tasks an actor's turn still waits for, because the turn is ending. It
   * gives each one's call with what the call is answered with.
   */
  async detachForTurnEnd(
    actor: ActorId,
    why = 'the turn ended',
  ): Promise<{ readonly call: string; readonly text: string }[]> {
    const tasks = await this.#store.detachTasks(actor);
    return tasks.map((task) => ({
      call: task.callId,
      text: this.#handle(task, `moved to the background, ${why}`),
    }));
  }

  /** Has the work of an actor's tasks stop, for an actor that is no more. Nothing is told of it. */
  forget(actor: ActorId): void {
    for (const [key, running] of this.#running) {
      if (key.startsWith(`${actor}/`)) running.stop.abort();
    }
  }

  /** Watches every task that was running when the engine last stopped. It gives how many. */
  async recover(): Promise<number> {
    const tasks = await this.#store.runningTasks();
    for (const task of tasks) this.#watch(task);
    return tasks.length;
  }

  /**
   * The engine is going away: every call that waits for a task is answered with nothing, at
   * once, and the work of each task is left as it is.
   */
  closing(): void {
    this.#closing.abort();
    for (const running of this.#running.values()) clearTimeout(running.timer);
    for (const listeners of this.#listeners.values()) for (const listener of listeners) listener();
  }

  /** Stops watching, and resolves once nothing of a task is being stored. */
  async close(): Promise<void> {
    this.closing();
    await Promise.all([...this.#running.values()].map((running) => running.settled));
    await Promise.all(this.#kinds.map((kind) => kind.close?.()));
  }

  #kindOf(task: StoredTask): TaskKind | undefined {
    return this.#kinds.find((one) => one.kind === task.kind);
  }

  /** What a call is answered with when its task goes on without it: its ID, and where to look at it. */
  #handle(task: StoredTask, lead: string): string {
    const where = this.#kindOf(task)?.where?.(workOf(task));
    return `${lead} · task ${task.id}${where === undefined ? '' : ` · ${where}`}`;
  }

  /** Resolves when something of the actor changes, `ms` have passed, or nobody waits any more. */
  #heard(actor: ActorId, ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let listeners = this.#listeners.get(actor);
      if (listeners === undefined) {
        listeners = new Set();
        this.#listeners.set(actor, listeners);
      }
      const set = listeners;
      const done = (): void => {
        clearTimeout(timer);
        set.delete(done);
        if (set.size === 0) this.#listeners.delete(actor);
        this.#closing.signal.removeEventListener('abort', done);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, Math.min(Math.max(ms, 0), LONGEST_TIMER_MS));
      set.add(done);
      this.#closing.signal.addEventListener('abort', done, { once: true });
      signal.addEventListener('abort', done, { once: true });
    });
  }

  /**
   * Waits for an attached task on behalf of its call: until it ends, until its wait runs out,
   * or until a person's message finds it past the floor.
   */
  async #await(actor: ActorId, id: string, waiting: Waiting): Promise<Answer | undefined> {
    for (;;) {
      if (this.#closing.signal.aborted || waiting.signal.aborted) return undefined;
      const task = await this.#store.loadTask(actor, id);
      if (task === undefined) throw new TaskNotFound(actor, id);
      if (task.status !== 'running') {
        // Let go of before a restart, and ended since: its notice tells how, not this call too.
        if (!task.attached) return { text: this.#handle(task, 'moved to the background') };
        return {
          ...answerOf(task, resultOf(task, RESULT_CHARS)),
          ...(task.status === 'failed' || task.status === 'lost' ? { isError: true } : {}),
        };
      }
      if (!task.attached) return { text: this.#handle(task, 'running in the background') };
      const now = this.#clock();
      const waitAt = task.waitUntil ?? now;
      const floorAt = waiting.hasUserMail()
        ? task.startedAt + this.#times.floorMs
        : Number.POSITIVE_INFINITY;
      const at = Math.min(waitAt, floorAt);
      if (now >= at) {
        // It ended in the meantime: around again, to answer with its result.
        if (!(await this.#store.detachTask(actor, id))) continue;
        const ran = span(now - task.startedAt);
        const lead =
          floorAt <= waitAt
            ? `moved to the background after ${ran}, for a new message`
            : `moved to the background after ${ran}`;
        return { text: this.#handle(task, lead) };
      }
      await this.#heard(actor, at - now, waiting.signal);
    }
  }

  /** Runs a task's work in this process, or goes on watching it, until it ends. */
  #watch(task: StoredTask): void {
    const key = `${task.actor}/${task.id}`;
    if (this.#running.has(key) || this.#closing.signal.aborted) return;
    const kind = this.#kindOf(task);
    const stop = new AbortController();
    const running: Running = { stop, settled: Promise.resolve() };
    running.settled = (async () => {
      // Not before this task is in `#running`.
      await Promise.resolve();
      let end: TaskEnd;
      try {
        end =
          kind === undefined
            ? { status: 'lost', text: `This engine has no tasks of the kind ${task.kind}` }
            : await kind.run(workOf(task), { stop: stop.signal, closing: this.#closing.signal });
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        end = { status: 'failed', text: `The task failed: ${why}` };
      }
      // The engine is going away, and nothing asked for the work to stop: it is left running.
      if (this.#closing.signal.aborted && !stop.signal.aborted) return;
      await this.#end(task.actor, task.id, end, running.stoppedBy, running.quiet === true);
    })()
      .catch((error: unknown) => {
        this.#report(error);
      })
      .finally(() => {
        clearTimeout(running.timer);
        this.#running.delete(key);
      });
    this.#running.set(key, running);
    // A kind that keeps its own timeout is not timed here.
    if (task.timeoutAt !== null && kind?.timesOut !== true) {
      running.timer = setTimeout(
        () => {
          this.#stop(task, 'timeout').catch((error: unknown) => {
            this.#report(error);
          });
        },
        Math.min(Math.max(task.timeoutAt - this.#clock(), 0), LONGEST_TIMER_MS),
      );
    }
  }

  /**
   * Stores a task's ending. A task nothing waits for has its notice stored with it, unless
   * the model stopped it, which is told in `stop`'s answer.
   */
  async #end(
    actor: ActorId,
    id: string,
    end: TaskEnd,
    stoppedBy: TaskStoppedBy | undefined,
    quiet = false,
  ): Promise<void> {
    const task = await this.#store.loadTask(actor, id);
    if (task?.status !== 'running') return;
    const now = this.#clock();
    const by = stoppedBy ?? end.stoppedBy;
    // Its images are kept apart from the conversation, as any image an agent's code gives is.
    const images = (await this.#keep(actor, [...(end.images ?? [])].slice(0, TASK_IMAGES))).filter(
      (part) => part.type === 'image',
    );
    const ending: TaskEnding = {
      status: by === undefined ? end.status : 'stopped',
      stoppedBy: by ?? null,
      result: end.render === undefined ? end.text : end.render(RESULT_CHARS),
      summary: end.render === undefined ? null : end.render(NOTICE_CHARS),
      images,
      endedAt: now,
    };
    const ended: StoredTask = { ...task, ...ending };
    // The model stopped it: `stop`'s answer tells how it ended, and nothing tells it again.
    const notice: Input | null =
      stoppedBy === 'model'
        ? null
        : {
            id: this.#inputId(now),
            actor,
            type: NOTICE,
            externalId: null,
            message: noticeOf(ended, this.#kindOf(task)?.title?.(task.input), end.problem),
            receivedAt: now,
            deliveredAt: null,
            ...(quiet ? { quiet: true as const } : {}),
          };
    const stored = await this.#store.endTask(actor, id, ending, notice);
    if (!stored.ended) return;
    this.mailArrived(actor);
    // A quiet ending is in the mailbox, and starts nothing.
    if (stored.notified && notice !== null) this.#deliver(notice);
  }

  /** Has a running task stopped, and resolves once its ending is stored. */
  async #stop(task: StoredTask, by: TaskStoppedBy, quiet = false): Promise<void> {
    const running = this.#running.get(`${task.actor}/${task.id}`);
    if (running === undefined) {
      // Nothing watches it here: it is taken as stopped.
      await this.#end(task.actor, task.id, { status: 'done', text: '' }, by, quiet);
      return;
    }
    running.stoppedBy ??= by;
    if (quiet) running.quiet = true;
    running.stop.abort();
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(
        () => {
          resolve('late');
        },
        this.#kindOf(task)?.stopGraceMs ?? this.#times.stopGraceMs,
      );
    });
    const outcome = await Promise.race([running.settled, late]);
    clearTimeout(timer);
    if (outcome === 'late') {
      // Its work did not stop when told to. It is taken as stopped, and whatever it says later is dropped.
      await this.#end(
        task.actor,
        task.id,
        { status: 'done', text: 'It did not stop when it was told to.' },
        running.stoppedBy,
        running.quiet === true,
      );
    }
  }

  /** Answers the model's `stop`: how the task ended, or what tasks there are to stop. */
  async #stopForModel(actor: ActorId, id: string): Promise<Answer> {
    const task = await this.#store.loadTask(actor, id);
    if (task === undefined) {
      // No task of that name: it may be one of its subagents.
      const stopped = await this.#stopAgent?.(actor, id);
      if (stopped !== undefined) return stopped;
      const running = await this.list(actor, { running: true });
      const which =
        running.length === 0
          ? 'No task is running.'
          : `Running: ${running.map((one) => `${one.id} (${one.kind})`).join(', ')}`;
      return { text: `There is no task ${id}. ${which}`, isError: true };
    }
    if (task.status !== 'running') {
      const ago = span(this.#clock() - (task.endedAt ?? task.startedAt));
      return { text: `${task.id} had ended already, ${ago} ago: ${task.status}` };
    }
    await this.#stop(task, 'model');
    const after = await this.#store.loadTask(actor, id);
    if (after === undefined) throw new TaskNotFound(actor, id);
    const body = after.summary ?? tail(after.result ?? '', NOTICE_CHARS);
    const lead = `stopped ${after.id} after ${span(ranOf(after))}`;
    return answerOf(after, body === '' ? lead : `${lead}\n${body}`);
  }
}
