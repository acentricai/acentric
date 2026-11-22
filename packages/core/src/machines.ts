// Machines: the places commands run. A machine is a computer with the daemon on it. Its daemon
// connects to the engine, never the other way, and one that runs on the engine's own computer
// connects the same way.
//
// A machine is added here by a name, which gives a token. Its daemon enrols once with the token
// and its public key, and proves itself with that key on every connection after.
//
// A command is named by the actor and the task it is for. Its row is stored before the machine
// is asked to run it, and its ending is stored before the machine is told that the ending
// arrived. So neither side forgets one:
//
//   - the engine asks again for a command the machine never said it has, and the machine runs
//     a command of one name once;
//   - the machine sends an ending again until it is acknowledged;
//   - on every connection the machine says what it has, and a command the engine believed was
//     running there, which the machine does not have, is lost.
//
// Nothing is queued for a machine that is not connected: a command for it is refused. A command
// that runs when its machine drops goes on running there.
//
// What is done to one machine's commands is done one thing after another, so that what a
// connection is settled against is not changed under it.

import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';

import { COMMAND_NAME, FILE_BYTES, fromDaemonSchema, proofText } from '@acentric/protocol';
import type {
  AgentId,
  CommandEnded,
  CommandRef,
  MachineFilePart,
  MachineFileRequest,
  FromEngine,
  Hello,
  Machine,
  MachineAgents,
  MachineEnv,
  MachineErrorCode,
  MachineId,
  MachineRequests,
  ReadParams,
  ReadResult,
  WriteParams,
  WriteResult,
} from '@acentric/protocol';

import { Conflict, EngineError } from './errors.ts';
import type { CommandStatus, NewCommand, Store, StoredCommand, StoredMachine } from './store.ts';

/** A command that has ended. */
export type CommandEnd = StoredCommand & {
  readonly status: 'exited' | 'stopped' | 'failed' | 'lost';
};

export type CommandSpec = CommandRef & {
  /** Run by bash, with no input. */
  readonly command: string;
  /** Where it starts: an absolute path, or one that starts with `~`. */
  readonly cwd: string;
  /** Seconds it may run before the machine stops it. Without it, no limit. */
  readonly timeout?: number;
};

export type MachineTimes = {
  /** A connection whose daemon has said nothing for this long is given up. */
  readonly silenceMs: number;
  /** How long a daemon has to answer a request. */
  readonly requestMs: number;
  /** How long a daemon has to prove itself on a new connection. */
  readonly proofMs: number;
  /** How long a token to enrol with works. */
  readonly tokenMs: number;
  /**
   * How long after the engine starts a machine that has not connected yet is still expected
   * to: its daemon was connected to the engine before this one, and is on its way back.
   */
  readonly returnMs: number;
};

export const DEFAULT_MACHINE_TIMES: MachineTimes = {
  silenceMs: 45_000,
  requestMs: 30_000,
  proofMs: 10_000,
  tokenMs: 3_600_000,
  returnMs: 30_000,
};

/** The most bytes of a file an agent's code reads or writes in one call. */
export const AGENT_FILE_BYTES = 32 << 20;

/** The name a machine's own commands are kept under, in place of an actor's: no actor's ID starts with `_`. */
export const OWN = '_machine';

export class MachineNotFound extends EngineError {
  override readonly name = 'MachineNotFound';
  readonly code = 'not_found';
  readonly machineId: string;
  constructor(machineId: string) {
    super(`There is no machine ${machineId}`);
    this.machineId = machineId;
  }
}

export class InvalidMachine extends EngineError {
  override readonly name = 'InvalidMachine';
  readonly code = 'invalid_request';
}

/** A daemon tried to enrol with what does not let it. */
export class EnrolRefused extends EngineError {
  override readonly name = 'EnrolRefused';
  readonly code = 'forbidden';
}

/** The machine's daemon is not connected. Nothing was sent to it. */
export class MachineOffline extends EngineError {
  override readonly name = 'MachineOffline';
  readonly code = 'machine_offline';
  readonly machineId: string;
  constructor(machineId: string) {
    super(`The machine ${machineId} is not connected`);
    this.machineId = machineId;
  }
}

export class CommandNotFound extends EngineError {
  override readonly name = 'CommandNotFound';
  readonly code = 'not_found';
  constructor(actor: string, task: string) {
    super(`There is no command ${actor}/${task}`);
  }
}

/** The machine's daemon refused a request. */
export class MachineRefused extends EngineError {
  override readonly name = 'MachineRefused';
  readonly code = 'machine_refused';
  /** Why, as the daemon names it. */
  readonly reason: MachineErrorCode;
  constructor(reason: MachineErrorCode, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** The connection was lost, or the daemon did not answer in time. What was asked may have been done. */
export class ConnectionLost extends EngineError {
  override readonly name = 'ConnectionLost';
  readonly code = 'unavailable';
  constructor(machineId: string) {
    super(`The connection to the machine ${machineId} was lost before it answered`);
  }
}

/**
 * A daemon's connection, as whatever serves the engine gives it: a WebSocket, with nothing of
 * how it is served.
 */
export type MachineSocket = {
  send(text: string): void;
  /** Closes it, saying why with a code, or ends it at once without one. */
  close(code?: number, reason?: string): void;
  onMessage(listener: (text: string) => void): void;
  /** Called once, when it has closed, whichever side closed it. */
  onClose(listener: () => void): void;
};

/** What a machine's daemon said the machine is. */
export type MachineFacts = {
  readonly os: string | null;
  readonly arch: string | null;
  readonly home: string | null;
  readonly tasksDir: string | null;
};

const OPEN: readonly CommandStatus[] = ['starting', 'running'];
const isOpen = (status: CommandStatus): boolean => status === 'starting' || status === 'running';
const hashOf = (token: string): string => createHash('sha256').update(token).digest('hex');
const keyOf = (ref: CommandRef): string => `${ref.actor}/${ref.task}`;

/** The agents a machine is for, each once. */
function agentsOf(given: MachineAgents): MachineAgents {
  return given === '*' ? '*' : [...new Set(given)];
}

/** One connection of a machine's daemon. */
type Session = {
  readonly machine: MachineId;
  readonly socket: MachineSocket;
  /** The daemon proved which machine it is. */
  proved: boolean;
  /** It said what it has, and that was settled: commands can be sent. */
  online: boolean;
  /** Since when that is so. */
  since: number;
  /** When it last said anything. */
  heard: number;
  /** It is over. */
  closed: boolean;
  nextId: number;
  /** What it sent is taken one message after another. */
  chain: Promise<void>;
  proofTimer?: NodeJS.Timeout;
  readonly pending: Map<
    number,
    {
      readonly resolve: (result: unknown) => void;
      readonly reject: (error: Error) => void;
      readonly timer: NodeJS.Timeout;
    }
  >;
};

export type MachinesOptions = {
  readonly store: Store;
  /** Makes a machine's ID. */
  readonly id: (now: number) => MachineId;
  readonly times?: Partial<MachineTimes>;
  readonly clock?: () => number;
  /** Hears what the engine itself got wrong. Without it, the error is printed. */
  readonly report?: (error: unknown) => void;
  /**
   * The variables an actor's commands are run with, opened. They are asked for each time a
   * command is sent, and are kept with no command.
   */
  readonly envOf?: (actor: string) => Promise<MachineEnv>;
  /**
   * The SHA-256, in hex, of the daemon this engine hands out for a system. Undefined for a
   * system it hands out none for.
   */
  readonly build?: (os: string, arch: string) => string | undefined;
};

export class Machines {
  readonly #store: Store;
  readonly #id: (now: number) => MachineId;
  readonly #times: MachineTimes;
  readonly #clock: () => number;
  readonly #report: (error: unknown) => void;
  readonly #envOf: (actor: string) => Promise<MachineEnv>;
  readonly #build: (os: string, arch: string) => string | undefined;
  /** The proved connection of each machine that has one. */
  readonly #sessions = new Map<MachineId, Session>();
  /** Every connection there is, proved or not. */
  readonly #open = new Set<Session>();
  /** Those who wait for a command to end, or for a machine to connect. */
  readonly #listeners = new Map<string, Set<() => void>>();
  /** What is being done to each machine's commands, the last of it. */
  readonly #queues = new Map<string, Promise<void>>();
  /** What each machine's daemon last said of it, as it is known here. */
  readonly #facts = new Map<MachineId, MachineFacts>();
  readonly #watch: NodeJS.Timeout;
  readonly #startedAt = Date.now();
  /** The machines whose daemons have connected to this engine since it started. */
  readonly #seen = new Set<MachineId>();
  #closing = false;

  constructor(options: MachinesOptions) {
    this.#store = options.store;
    this.#id = options.id;
    this.#times = { ...DEFAULT_MACHINE_TIMES, ...options.times };
    this.#clock = options.clock ?? Date.now;
    this.#envOf = options.envOf ?? (async () => ({}));
    this.#build = options.build ?? (() => undefined);
    this.#report =
      options.report ??
      ((error) => {
        console.error(error);
      });
    // A daemon that went away without closing its connection says nothing more.
    this.#watch = setInterval(
      () => {
        const now = Date.now();
        for (const session of this.#open) {
          if (now - session.heard > this.#times.silenceMs) this.#drop(session);
        }
      },
      Math.max(10, Math.floor(this.#times.silenceMs / 3)),
    );
    this.#watch.unref();
  }

  // Machines

  /** Adds a machine, and gives the token its daemon enrols with. */
  async add(given: {
    readonly name: string;
    readonly agents?: MachineAgents;
  }): Promise<{ readonly machine: Machine; readonly token: string; readonly expiresAt: number }> {
    const now = this.#clock();
    const { token, tokenHash, tokenExpiresAt } = this.#newToken(now);
    const stored: StoredMachine = {
      id: this.#id(now),
      name: given.name,
      // It is for no agent until it is said which.
      agents: given.agents === undefined ? [] : agentsOf(given.agents),
      tokenHash,
      tokenExpiresAt,
      publicKey: null,
      os: null,
      arch: null,
      home: null,
      hostname: null,
      version: null,
      build: null,
      tasksDir: null,
      createdAt: now,
      enrolledAt: null,
      lastSeenAt: null,
      sandbox: null,
    };
    await this.#store.addMachine(stored);
    return { machine: this.#info(stored), token, expiresAt: tokenExpiresAt };
  }

  /**
   * Gives a new token for a machine that is there, for its daemon to enrol again: a machine
   * whose folder was lost. Until a daemon enrols with it, the machine is as it was.
   */
  async token(
    id: MachineId,
  ): Promise<{ readonly machine: Machine; readonly token: string; readonly expiresAt: number }> {
    const { token, tokenHash, tokenExpiresAt } = this.#newToken(this.#clock());
    const stored = await this.#store.changeMachine(id, { tokenHash, tokenExpiresAt });
    if (stored === undefined) throw new MachineNotFound(id);
    return { machine: this.#info(stored), token, expiresAt: tokenExpiresAt };
  }

  #newToken(now: number): { token: string; tokenHash: string; tokenExpiresAt: number } {
    const token = randomBytes(32).toString('hex');
    return { token, tokenHash: hashOf(token), tokenExpiresAt: now + this.#times.tokenMs };
  }

  /** Takes a daemon's public key for a machine, for the machine's token. The token works once. */
  async enrol(
    id: MachineId,
    given: { readonly token: string; readonly publicKey: string },
  ): Promise<Machine> {
    try {
      const key = createPublicKey({
        key: Buffer.from(given.publicKey, 'base64'),
        format: 'der',
        type: 'spki',
      });
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('not Ed25519');
    } catch {
      throw new InvalidMachine('publicKey is an Ed25519 public key, as base64 of its SPKI form');
    }
    const now = this.#clock();
    const stored = await this.#store.loadMachine(id);
    const hash = hashOf(given.token);
    const matches =
      stored !== undefined &&
      stored.tokenHash !== null &&
      stored.tokenExpiresAt !== null &&
      stored.tokenExpiresAt > now &&
      timingSafeEqual(Buffer.from(stored.tokenHash), Buffer.from(hash)) &&
      // Of two that enrol with one token at once, one does.
      (await this.#store.enrolMachine(id, hash, given.publicKey, now));
    // One answer for every reason, so that nothing is learned by trying.
    if (!matches) throw new EnrolRefused(`The token is not one the machine ${id} can enrol with`);
    // A daemon that was connected with the key before this one is no longer the machine.
    const before = this.#sessions.get(id);
    if (before !== undefined) this.#drop(before);
    return this.get(id);
  }

  /** Renames a machine, or says which agents it is for from now on. Actors that are on it stay. */
  async update(
    id: MachineId,
    changes: { readonly name?: string; readonly agents?: MachineAgents },
  ): Promise<Machine> {
    const stored = await this.#store.changeMachine(id, {
      ...(changes.name === undefined ? {} : { name: changes.name }),
      ...(changes.agents === undefined ? {} : { agents: agentsOf(changes.agents) }),
    });
    if (stored === undefined) throw new MachineNotFound(id);
    return this.#info(stored);
  }

  /**
   * What stands in the way of an actor of `agent` working on a machine: there is no such
   * machine, or it is not for that agent. Undefined when nothing does.
   */
  async refuses(id: MachineId, agent: AgentId): Promise<string | undefined> {
    const stored = await this.#store.loadMachine(id);
    if (stored === undefined) return `There is no machine ${id}`;
    if (stored.agents === '*' || stored.agents.includes(agent)) return undefined;
    return `The machine ${id} is not for the agent ${agent}: whoever keeps the machines says which agents work on it`;
  }

  async get(id: MachineId): Promise<Machine> {
    const stored = await this.#store.loadMachine(id);
    if (stored === undefined) throw new MachineNotFound(id);
    return this.#info(stored);
  }

  /** The machine of a name, if there is one. */
  async find(name: string): Promise<Machine | undefined> {
    const stored = await this.#store.findMachine(name);
    return stored === undefined ? undefined : this.#info(stored);
  }

  /** Every machine, in the order they were added. */
  async list(): Promise<Machine[]> {
    return (await this.#store.listMachines()).map((stored) => this.#info(stored));
  }

  /** Removes a machine. Its daemon is disconnected, and what the engine had running there is lost. */
  async remove(id: MachineId): Promise<void> {
    const lost = await this.#serial(id, () =>
      this.#store.removeMachine(id, {
        error: 'Its machine was removed',
        endedAt: this.#clock(),
      }),
    );
    if (lost === undefined) throw new MachineNotFound(id);
    this.#facts.delete(id);
    const session = this.#sessions.get(id);
    if (session !== undefined) this.#drop(session);
    for (const command of lost) this.#notify(keyOf(command));
  }

  /** How many commands have not ended on a machine. */
  async busy(id: MachineId): Promise<number> {
    return (await this.#store.openCommands(id)).length;
  }

  /**
   * What every machine's daemon last said, read from the store: what a process does when it
   * starts, so that it knows a machine before the machine's daemon has found it again.
   */
  async load(): Promise<void> {
    for (const stored of await this.#store.listMachines()) {
      if (!this.#facts.has(stored.id)) this.#facts.set(stored.id, factsOf(stored));
    }
  }

  /** What a machine's daemon last said the machine is. Undefined for one never heard of here. */
  facts(id: MachineId): MachineFacts | undefined {
    return this.#facts.get(id);
  }

  /** Resolves once the machine's daemon is connected. For tests, and for anyone who can wait. */
  async whenOnline(id: MachineId): Promise<void> {
    while (this.#sessions.get(id)?.online !== true && !this.#closing) {
      await this.#listen(`machine:${id}`).heard;
    }
  }

  /** Since when a machine's daemon has been connected, on this engine's clock. Undefined when it is not. */
  onlineSince(id: MachineId): number | undefined {
    const session = this.#sessions.get(id);
    return session?.online === true ? session.since : undefined;
  }

  /**
   * Resolves once the machine's daemon is connected, with a connection made at `since` or
   * later when that is given, or after `waitMs`. True when it is connected.
   */
  async online(id: MachineId, waitMs: number, since = 0): Promise<boolean> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const connected = this.onlineSince(id);
      if (connected !== undefined && connected >= since) return true;
      const left = deadline - Date.now();
      if (left <= 0 || this.#closing) return false;
      // Whichever comes first, the other is let go of.
      const waiting = this.#listen(`machine:${id}`);
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        waiting.heard,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.min(left, 250));
        }),
      ]);
      clearTimeout(timer);
      waiting.done();
    }
  }

  /**
   * Gives a machine that is on its way back the time to arrive. An engine that has just
   * started has no connections yet, and the daemons that were connected to the one before it
   * take a moment to find it: until that moment has passed, a machine that has enrolled and
   * has not been heard from is waited for. Resolves at once for any other machine, connected
   * or not, and when `signal` fires.
   */
  async settled(id: MachineId, signal?: AbortSignal): Promise<void> {
    const until = this.#startedAt + this.#times.returnMs;
    const expected = async (): Promise<boolean> =>
      !this.#closing &&
      signal?.aborted !== true &&
      !this.#seen.has(id) &&
      Date.now() < until &&
      (await this.#store.loadMachine(id))?.publicKey != null;
    for (;;) {
      const waiting = this.#listen(`machine:${id}`, signal);
      if (!(await expected()) || this.#seen.has(id)) {
        waiting.done();
        return;
      }
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        waiting.heard,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, until - Date.now()));
        }),
      ]);
      clearTimeout(timer);
      waiting.done();
    }
  }

  /** Resolves once the machine's daemon is not connected. */
  async whenOffline(id: MachineId): Promise<void> {
    while (this.#sessions.has(id) && !this.#closing) await this.#listen(`machine:${id}`).heard;
  }

  /**
   * Has a machine's daemon take the build of it this engine hands out, and waits for the
   * daemon to be back as that build. `updated` is false when it was that build already.
   */
  async upgrade(id: MachineId): Promise<{ readonly machine: Machine; readonly updated: boolean }> {
    const stored = await this.#store.loadMachine(id);
    if (stored === undefined) throw new MachineNotFound(id);
    const session = this.#sessions.get(id);
    if (session?.online !== true) throw new MachineOffline(id);
    const system = `${stored.os ?? 'unknown'}-${stored.arch ?? 'unknown'}`;
    const digest =
      stored.os === null || stored.arch === null ? undefined : this.#build(stored.os, stored.arch);
    if (digest === undefined) {
      throw new Conflict(`This engine hands out no machine program for ${system}`);
    }
    if (stored.build === digest) return { machine: this.#info(stored), updated: false };
    // A daemon from before there were updates knows no such method.
    let answer: MachineRequests['update']['result'];
    try {
      // The daemon fetches its program before it answers.
      answer = await this.#request(session, 'update', { digest }, this.#times.requestMs * 4);
    } catch (error) {
      if (error instanceof MachineRefused && /no such method/i.test(error.message)) {
        throw new MachineRefused(
          'invalid',
          `The machine ${id} runs a machine program too old to update itself: install it again`,
        );
      }
      throw error;
    }
    if (answer.updated) {
      // It starts again as the new program, and connects again: waited for until it has, on
      // another connection than the one it was asked on, whichever of the two is seen first to
      // go and to come.
      const deadline = Date.now() + this.#times.returnMs;
      for (;;) {
        const now = this.#sessions.get(id);
        const back = now !== undefined && now !== session && now.online;
        const left = deadline - Date.now();
        if (back || left <= 0 || this.#closing) break;
        const waiting = this.#listen(`machine:${id}`);
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          waiting.heard,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, Math.min(left, 250));
          }),
        ]);
        clearTimeout(timer);
        waiting.done();
      }
    }
    return { machine: await this.get(id), updated: answer.updated };
  }

  // Commands

  /**
   * Has a machine start a command, unless there is a command of this actor and task already.
   * The machine must be connected: nothing is stored for one that is not.
   */
  async start(machineId: MachineId, spec: CommandSpec): Promise<StoredCommand> {
    if (!COMMAND_NAME.test(spec.actor) || !COMMAND_NAME.test(spec.task)) {
      throw new InvalidMachine('A command is named by an actor and a task');
    }
    return this.#serial(machineId, async () => {
      const before = await this.#store.loadCommand(spec.actor, spec.task);
      if (before !== undefined) return before;
      return this.#begin(machineId, spec.actor, async () => {
        const added = await this.#store.addCommand(newCommand(machineId, spec, this.#clock()));
        return added.command;
      });
    });
  }

  /** Stores a command for a machine that is connected, and asks the machine to run it. */
  async #begin(
    machineId: MachineId,
    actor: string,
    store: () => Promise<StoredCommand>,
  ): Promise<StoredCommand> {
    if ((await this.#store.loadMachine(machineId)) === undefined) {
      throw new MachineNotFound(machineId);
    }
    const session = this.#sessions.get(machineId);
    if (session?.online !== true) throw new MachineOffline(machineId);
    // Before anything is stored: a command whose variables cannot be opened is not started.
    const env = await this.#envOf(actor);
    const command = await store();
    this.#sendRun(session, command, env);
    return command;
  }

  /**
   * Where a command's output is, or will be, on its machine: known from what the machine's
   * daemon last said, before the command has started. A path under the home directory there
   * is given from `~`.
   */
  logOf(machineId: MachineId, ref: CommandRef): string | undefined {
    const facts = this.#facts.get(machineId);
    if (facts === undefined || facts.tasksDir === null) return undefined;
    const path = `${facts.tasksDir}/${ref.actor}/${ref.task}/output.log`;
    return facts.home !== null && path.startsWith(`${facts.home}/`)
      ? `~${path.slice(facts.home.length)}`
      : path;
  }

  /** The command of an actor's task, when there is one. */
  command(ref: CommandRef): Promise<StoredCommand | undefined> {
    return this.#store.loadCommand(ref.actor, ref.task);
  }

  /**
   * Resolves with how a command ended, once it has. Resolves with undefined when `signal`
   * fires or the engine is going away first.
   */
  async ended(ref: CommandRef, signal?: AbortSignal): Promise<CommandEnd | undefined> {
    for (;;) {
      if (this.#closing || signal?.aborted === true) return undefined;
      // Listened for before it is read, so that an ending between the two is not missed.
      const waiting = this.#listen(keyOf(ref), signal);
      let command: StoredCommand | undefined;
      try {
        command = await this.#store.loadCommand(ref.actor, ref.task);
      } catch (error) {
        waiting.done();
        throw error;
      }
      if (command === undefined || !isOpen(command.status)) {
        waiting.done();
        if (command === undefined) throw new CommandNotFound(ref.actor, ref.task);
        return command as CommandEnd;
      }
      await waiting.heard;
    }
  }

  /** Starts a command and waits for its end. Called again for a command that is under way, it waits for that one. */
  async run(
    machineId: MachineId,
    spec: CommandSpec,
    signal?: AbortSignal,
  ): Promise<CommandEnd | undefined> {
    await this.start(machineId, spec);
    return this.ended(spec, signal);
  }

  /**
   * Asks for a command to be stopped. The asking is stored, and is sent again when its
   * machine connects, so a stop is not lost with a connection. The ending arrives as every
   * ending does.
   */
  async stop(ref: CommandRef): Promise<void> {
    const current = await this.#store.loadCommand(ref.actor, ref.task);
    if (current === undefined) throw new CommandNotFound(ref.actor, ref.task);
    if (!isOpen(current.status)) return;
    await this.#serial(current.machine, async () => {
      const wanted = await this.#store.changeCommand(
        ref.actor,
        ref.task,
        { stopWanted: true },
        OPEN,
      );
      if (!wanted) return;
      const session = this.#sessions.get(current.machine);
      if (session?.online === true) this.#sendStop(session, ref);
    });
  }

  /**
   * Starts a command of the machine's own, for no actor: one run from outside. Its ID, `c1`,
   * `c2`, …, is the engine's. The machine must be connected.
   */
  async startOwn(
    machineId: MachineId,
    spec: { readonly command: string; readonly cwd: string; readonly timeout?: number },
  ): Promise<StoredCommand> {
    return this.#serial(machineId, () =>
      this.#begin(machineId, OWN, () =>
        this.#store.addOwnCommand({
          actor: OWN,
          machine: machineId,
          command: spec.command,
          cwd: spec.cwd,
          timeout: spec.timeout ?? null,
          startedAt: this.#clock(),
        }),
      ),
    );
  }

  /** A command of the machine's own, by its ID. */
  async own(machineId: MachineId, id: string): Promise<StoredCommand> {
    if ((await this.#store.loadMachine(machineId)) === undefined) {
      throw new MachineNotFound(machineId);
    }
    const command = await this.#store.loadCommand(OWN, id);
    if (command?.machine !== machineId) throw new CommandNotFound(machineId, id);
    return command;
  }

  /** The machine's own commands, newest first, at most `limit`. */
  async owns(machineId: MachineId, limit: number): Promise<StoredCommand[]> {
    if ((await this.#store.loadMachine(machineId)) === undefined) {
      throw new MachineNotFound(machineId);
    }
    return this.#store.listCommands(OWN, machineId, limit);
  }

  /**
   * A part of a file of a machine, as an agent's code reads or writes it from its actor's
   * working directory. Its code moves a file in as many parts as it takes, and no file larger
   * than it may: one that is, is refused before any of it is written.
   */
  async file(
    machine: { readonly id: MachineId; readonly cwd: string },
    request: MachineFileRequest,
  ): Promise<MachineFilePart | undefined> {
    const { id, cwd } = machine;
    const { path, from } = request;
    const tooLarge = (bytes: number): MachineRefused =>
      new MachineRefused(
        'invalid',
        `${path} is ${String(bytes)} bytes: an agent's code reads and writes files of at most ${String(AGENT_FILE_BYTES >> 20)} MiB`,
      );
    if (request.op === 'read') {
      const read = await this.read(id, { path, cwd, from, max: FILE_BYTES });
      if (read.size > AGENT_FILE_BYTES) throw tooLarge(read.size);
      return { size: read.size, data: read.data };
    }
    // What the code says the file is to be, and no less than what it has sent of it.
    const { data } = request;
    const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    const size = Math.max(request.size, from + (data.length / 4) * 3 - padding);
    if (size > AGENT_FILE_BYTES) throw tooLarge(size);
    await this.write(id, { path, cwd, from, data });
    return undefined;
  }

  /** Writes bytes to a file on a machine. */
  async write(machineId: MachineId, params: WriteParams): Promise<WriteResult> {
    return this.#request(await this.#connected(machineId), 'write', params);
  }

  /** Reads bytes of a file on a machine. */
  async read(machineId: MachineId, params: ReadParams): Promise<ReadResult> {
    return this.#request(await this.#connected(machineId), 'read', params);
  }

  /** The connection of a machine that is there and connected. */
  async #connected(machineId: MachineId): Promise<Session> {
    if ((await this.#store.loadMachine(machineId)) === undefined) {
      throw new MachineNotFound(machineId);
    }
    const session = this.#sessions.get(machineId);
    if (session?.online !== true) throw new MachineOffline(machineId);
    return session;
  }

  // Connections

  /** Whether a daemon may connect as a machine: one that has enrolled, on an engine that is not going away. */
  async accepts(id: MachineId): Promise<boolean> {
    if (this.#closing) return false;
    return (await this.#store.loadMachine(id))?.publicKey != null;
  }

  /**
   * Takes a daemon's connection for a machine. The daemon is asked to prove that it is the
   * machine before anything else is heard from it.
   */
  connect(machineId: MachineId, socket: MachineSocket): void {
    const session: Session = {
      machine: machineId,
      socket,
      proved: false,
      online: false,
      since: 0,
      heard: Date.now(),
      closed: false,
      nextId: 1,
      chain: Promise.resolve(),
      pending: new Map(),
    };
    if (this.#closing) {
      socket.close();
      return;
    }
    this.#open.add(session);
    const nonce = randomBytes(32).toString('base64');
    session.proofTimer = setTimeout(() => {
      if (!session.proved) this.#drop(session, 4401, 'No proof');
    }, this.#times.proofMs);

    socket.onMessage((text) => {
      session.heard = Date.now();
      let parsed;
      try {
        parsed = fromDaemonSchema.safeParse(JSON.parse(text));
      } catch {
        return;
      }
      // What is none of what a daemon sends is passed over.
      if (!parsed.success) return;
      const message = parsed.data;
      // An answer is given to whoever waits for it at once: it waits behind nothing.
      if (session.proved && message.type === 'response') {
        this.#answered(session, message);
        return;
      }
      if (session.proved && message.type === 'ping') {
        this.#send(session, { type: 'pong' });
        return;
      }
      session.chain = session.chain
        .then(async () => {
          if (session.closed) return;
          if (!session.proved) {
            const proves =
              message.type === 'proof' && (await this.#proves(machineId, nonce, message.signature));
            if (session.closed) return;
            if (!proves) {
              this.#drop(session, 4401, 'Not this machine');
              return;
            }
            session.proved = true;
            clearTimeout(session.proofTimer);
            // One connection for a machine: the newest.
            const before = this.#sessions.get(machineId);
            if (before !== undefined) this.#drop(before);
            this.#sessions.set(machineId, session);
            this.#send(session, { type: 'ready' });
            return;
          }
          if (message.type === 'hello') {
            await this.#serial(machineId, () => this.#settle(session, message));
          } else if (message.type === 'ended') {
            await this.#serial(machineId, () => this.#storeEnded(session, message));
          }
        })
        .catch((error: unknown) => {
          this.#report(error);
        });
    });
    socket.onClose(() => {
      this.#dropped(session);
    });
    this.#send(session, { type: 'challenge', nonce });
  }

  /** Drops every connection. The commands on the machines go on. */
  close(): void {
    this.#closing = true;
    clearInterval(this.#watch);
    // Each takes itself out as it goes: a set gives what is left of it.
    for (const session of this.#open) this.#drop(session);
    for (const listeners of this.#listeners.values()) {
      for (const listener of listeners) listener();
    }
  }

  /** Ends a connection from this side. */
  #drop(session: Session, code?: number, reason?: string): void {
    try {
      session.socket.close(code, reason);
    } catch {
      // It was going already.
    }
    this.#dropped(session);
  }

  /** A connection is over, whichever side ended it. */
  #dropped(session: Session): void {
    if (session.closed) return;
    session.closed = true;
    clearTimeout(session.proofTimer);
    this.#open.delete(session);
    for (const waiting of session.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new ConnectionLost(session.machine));
    }
    session.pending.clear();
    if (this.#sessions.get(session.machine) !== session) return;
    this.#sessions.delete(session.machine);
    session.online = false;
    if (!this.#closing) {
      this.#store
        .changeMachine(session.machine, { lastSeenAt: this.#clock() })
        .catch((error: unknown) => {
          this.#report(error);
        });
    }
    this.#notify(`machine:${session.machine}`);
  }

  async #proves(machineId: MachineId, nonce: string, signature: string): Promise<boolean> {
    const stored = await this.#store.loadMachine(machineId);
    if (stored === undefined || stored.publicKey === null) return false;
    try {
      const key = createPublicKey({
        key: Buffer.from(stored.publicKey, 'base64'),
        format: 'der',
        type: 'spki',
      });
      return verify(
        null,
        Buffer.from(proofText(machineId, nonce)),
        key,
        Buffer.from(signature, 'base64'),
      );
    } catch {
      return false;
    }
  }

  #answered(session: Session, message: Extract<FromDaemonMessage, { type: 'response' }>): void {
    const waiting = session.pending.get(message.id);
    if (waiting === undefined) return;
    session.pending.delete(message.id);
    clearTimeout(waiting.timer);
    if (message.error !== undefined) {
      waiting.reject(new MachineRefused(message.error.code, message.error.message));
    } else {
      waiting.resolve(message.result);
    }
  }

  /**
   * A daemon said what its machine has. Every command the engine holds open there is settled
   * against it: one the machine never got is asked for again, and one it had and no longer
   * has is lost.
   */
  async #settle(session: Session, hello: Hello): Promise<void> {
    const machineId = session.machine;
    const now = this.#clock();
    const stored = await this.#store.changeMachine(machineId, {
      os: hello.os,
      arch: hello.arch,
      home: hello.home,
      hostname: hello.hostname,
      version: hello.version,
      build: hello.build ?? null,
      tasksDir: hello.tasks ?? null,
      lastSeenAt: now,
    });
    // It was removed while its daemon was connecting.
    if (stored === undefined) return;
    this.#facts.set(machineId, factsOf(stored));

    const running = new Map(hello.running.map((one) => [keyOf(one), one.log]));
    const ending = new Set(hello.ended.map(keyOf));
    const again: StoredCommand[] = [];
    const stops: CommandRef[] = [];
    const settled: string[] = [];
    for (const command of await this.#store.openCommands(machineId)) {
      const { actor, task } = command;
      const key = keyOf(command);
      const log = running.get(key);
      if (log !== undefined) {
        if (command.status === 'starting') {
          await this.#store.changeCommand(actor, task, { status: 'running', log }, ['starting']);
        }
        if (command.stopWanted) stops.push({ actor, task });
      } else if (ending.has(key)) {
        // Its ending follows on this connection.
      } else if (command.status === 'starting') {
        if (command.stopWanted) {
          // It was stopped before the machine ever had it.
          const stopped = await this.#store.changeCommand(
            actor,
            task,
            {
              status: 'stopped',
              stoppedBy: 'stop',
              ranMs: 0,
              bytes: 0,
              lines: 0,
              tail: '',
              endedAt: now,
            },
            OPEN,
          );
          if (stopped) settled.push(key);
        } else {
          again.push(command);
        }
      } else {
        const lost = await this.#store.changeCommand(
          actor,
          task,
          {
            status: 'lost',
            error: 'Its machine no longer has it: the machine restarted, or its folder was removed',
            endedAt: now,
          },
          OPEN,
        );
        if (lost) settled.push(key);
      }
    }
    for (const key of settled) this.#notify(key);
    // The connection went while this was read: the next one is settled as this was.
    if (session.closed || this.#sessions.get(machineId) !== session) return;
    session.online = true;
    session.since = Date.now();
    this.#seen.add(machineId);
    for (const command of again) this.#sendRun(session, command);
    for (const ref of stops) this.#sendStop(session, ref);
    this.#notify(`machine:${machineId}`);
  }

  /** Stores an ending, and only then tells the machine that it arrived. */
  async #storeEnded(session: Session, ended: CommandEnded): Promise<void> {
    const ref = { actor: ended.actor, task: ended.task };
    const command = await this.#store.loadCommand(ref.actor, ref.task);
    let stored = false;
    // Not a command of this engine's, or one that has its ending: the machine can forget it.
    if (command !== undefined && command.machine === session.machine && isOpen(command.status)) {
      const { status } = ended;
      stored = await this.#store.changeCommand(
        ref.actor,
        ref.task,
        {
          status,
          exit: ended.exit,
          stoppedBy: status === 'stopped' ? (ended.by ?? 'stop') : null,
          ranMs: Math.round(ended.ranMs),
          bytes: Math.round(ended.bytes),
          lines: Math.round(ended.lines),
          tail: ended.tail,
          error:
            status === 'lost'
              ? 'It is gone and left no exit status: its machine restarted, or it was killed from outside'
              : null,
          endedAt: this.#clock(),
        },
        OPEN,
      );
    }
    this.#send(session, { type: 'ack', ...ref });
    if (stored) this.#notify(keyOf(ref));
  }

  /**
   * Asks a machine to run a command. Its actor's variables go with it: they are read now, each
   * time it is sent, and are not kept with the command.
   */
  #sendRun(session: Session, command: StoredCommand, given?: MachineEnv): void {
    const ref = { actor: command.actor, task: command.task };
    const sent = async (): Promise<void> => {
      let env: MachineEnv;
      try {
        env = given ?? (await this.#envOf(command.actor));
      } catch (error) {
        // It is not run without them. It stays as it is, and is sent again on the next connection.
        this.#report(error);
        return;
      }
      try {
        const result = await this.#request(session, 'run', {
          ...ref,
          command: command.command,
          cwd: command.cwd,
          ...(command.timeout === null ? {} : { timeout: command.timeout }),
          ...(Object.keys(env).length === 0 ? {} : { env }),
        });
        await this.#store.changeCommand(
          ref.actor,
          ref.task,
          { status: 'running', log: String(result.log) },
          ['starting'],
        );
      } catch (error) {
        // The machine said no: the command did not start, and will not.
        if (error instanceof MachineRefused) {
          const failed = await this.#store.changeCommand(
            ref.actor,
            ref.task,
            { status: 'failed', error: error.message, endedAt: this.#clock() },
            OPEN,
          );
          if (failed) this.#notify(keyOf(ref));
          return;
        }
        // No answer: it may have started. It stays `starting`, and is settled on the next connection.
        if (!(error instanceof ConnectionLost)) this.#report(error);
      }
    };
    sent().catch((error: unknown) => {
      this.#report(error);
    });
  }

  #sendStop(session: Session, ref: CommandRef): void {
    this.#request(session, 'stop', ref).catch((error: unknown) => {
      // The asking is stored: it is sent again on the next connection.
      if (!(error instanceof ConnectionLost) && !(error instanceof MachineRefused)) {
        this.#report(error);
      }
    });
  }

  #request<M extends keyof MachineRequests>(
    session: Session,
    method: M,
    params: MachineRequests[M]['params'],
    withinMs = this.#times.requestMs,
  ): Promise<MachineRequests[M]['result']> {
    return new Promise((resolve, reject) => {
      if (session.closed) {
        reject(new ConnectionLost(session.machine));
        return;
      }
      const id = session.nextId++;
      const timer = setTimeout(() => {
        // A daemon that does not answer is not one to go on talking to.
        this.#drop(session);
      }, withinMs);
      session.pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timer,
      });
      this.#send(session, { type: 'request', id, method, params });
    });
  }

  #send(session: Session, message: FromEngine): void {
    try {
      if (!session.closed) session.socket.send(JSON.stringify(message));
    } catch {
      // The connection is going. What matters is stored, and is settled on the next one.
    }
  }

  #info(stored: StoredMachine): Machine {
    const handedOut =
      stored.os === null || stored.arch === null ? undefined : this.#build(stored.os, stored.arch);
    return {
      id: stored.id,
      name: stored.name as Machine['name'],
      agents: stored.agents,
      enrolled: stored.publicKey !== null,
      online: this.#sessions.get(stored.id)?.online === true,
      os: stored.os,
      arch: stored.arch,
      home: stored.home,
      hostname: stored.hostname,
      version: stored.version,
      current: stored.build === null || handedOut === undefined ? null : stored.build === handedOut,
      provider: stored.sandbox?.provider ?? null,
      createdAt: stored.createdAt,
      enrolledAt: stored.enrolledAt,
      lastSeenAt: stored.lastSeenAt,
    };
  }

  /** Does `work` once everything asked of this machine's commands before it is done. */
  #serial<T>(machine: string, work: () => Promise<T>): Promise<T> {
    const before = this.#queues.get(machine) ?? Promise.resolve();
    const done = before.then(work);
    const settled = done.then(
      () => {},
      () => {},
    );
    this.#queues.set(machine, settled);
    void settled.then(() => {
      if (this.#queues.get(machine) === settled) this.#queues.delete(machine);
    });
    return done;
  }

  /**
   * Listens for `key` from now on. `heard` resolves when it is notified, `signal` fires, or
   * the engine is going away; `done` stops listening, for one who no longer waits.
   */
  #listen(key: string, signal?: AbortSignal): { heard: Promise<void>; done: () => void } {
    let done = (): void => {};
    const heard = new Promise<void>((resolve) => {
      let listeners = this.#listeners.get(key);
      if (listeners === undefined) {
        listeners = new Set();
        this.#listeners.set(key, listeners);
      }
      const set = listeners;
      done = (): void => {
        set.delete(done);
        if (set.size === 0 && this.#listeners.get(key) === set) this.#listeners.delete(key);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      set.add(done);
      signal?.addEventListener('abort', done, { once: true });
      if (this.#closing || signal?.aborted === true) done();
    });
    return { heard, done };
  }

  #notify(key: string): void {
    for (const listener of this.#listeners.get(key) ?? []) listener();
  }
}

type FromDaemonMessage = ReturnType<typeof fromDaemonSchema.parse>;

function factsOf(stored: StoredMachine): MachineFacts {
  return { os: stored.os, arch: stored.arch, home: stored.home, tasksDir: stored.tasksDir };
}

function newCommand(machine: MachineId, spec: CommandSpec, now: number): NewCommand {
  return {
    actor: spec.actor,
    task: spec.task,
    machine,
    command: spec.command,
    cwd: spec.cwd,
    timeout: spec.timeout ?? null,
    startedAt: now,
  };
}
