// Sandboxes: machines the engine makes at a provider, where a person would otherwise enrol
// one. Once made, a sandbox is a machine like any other: actors are created on it by its ID,
// and commands go to its daemon. What a provider is, is in `sandbox.ts`.
//
// An account at a provider is added first, with its API key where the provider has keys: the
// key is kept sealed. A sandbox is made from something that has the daemon in it. The
// provider is given a file to put in the new sandbox, with what its daemon needs to enrol,
// and the daemon enrols and connects when the sandbox starts.
//
// A sandbox sleeps when it is idle: it is stopped, and its disk is kept. Each has an idle
// time, and a moment that time runs out at, which is put off when a command starts, every
// half of the idle time while any command runs, and once more when the last one ends. Some
// providers stop a sandbox themselves when a timer of theirs runs out, and the engine sets
// that timer: such a sandbox stops even when the engine is not there. For the others the
// engine stops it. Before a command, a sandbox that has stopped is started again, and the
// command waits for its daemon to come back.

import { randomBytes } from 'node:crypto';

import {
  DEFAULT_SANDBOX_IDLE_S,
  MAX_SANDBOX_IDLE_S,
  MIN_SANDBOX_IDLE_S,
  SANDBOX_WAIT_MAX_S,
} from '@acentric/protocol';
import type {
  MachineAgents,
  MachineId,
  Sandbox,
  SandboxProviderAccount,
  SandboxProviderId,
  SandboxState,
} from '@acentric/protocol';

import { Conflict, EngineError } from './errors.ts';
import { MachineNotFound } from './machines.ts';
import type { Machines } from './machines.ts';
import { LABEL_MACHINE, LABEL_PROVIDER, ProviderFailed } from './sandbox.ts';
import type { ProviderSandbox, SandboxAccount, SandboxProvider } from './sandbox.ts';
import { SecretsUnavailable } from './secrets.ts';
import type { Secrets } from './secrets.ts';
import { NameTaken } from './store.ts';
import type { Store, StoredMachine, StoredSandbox, StoredSandboxProvider } from './store.ts';

export type SandboxTimes = {
  /** How long a create waits for the new sandbox's daemon, when the call does not say. */
  readonly waitMs: number;
  /** How long a command waits for a sandbox that is being started again. */
  readonly wakeMs: number;
  /** How long a provider has to answer. */
  readonly requestMs: number;
  /** How close to running out a sandbox's idle time may be, before a command has it put off first. */
  readonly marginMs: number;
  /** How often the engine looks at which sandboxes are due. */
  readonly tickMs: number;
  /** The least and the most between two times a sandbox's idle time is put off while commands run. */
  readonly minIntervalMs: number;
  readonly maxIntervalMs: number;
  /** How soon after a command started it is put off, at the earliest after the last time. */
  readonly debounceMs: number;
  /** How long after a provider could not be asked it is asked again. */
  readonly retryMs: number;
  /** How long between two tries to start a sandbox that is still stopping. */
  readonly stoppingMs: number;
};

export const DEFAULT_SANDBOX_TIMES: SandboxTimes = {
  waitMs: 60_000,
  wakeMs: 90_000,
  requestMs: 30_000,
  marginMs: 60_000,
  tickMs: 5_000,
  minIntervalMs: 30_000,
  maxIntervalMs: 600_000,
  debounceMs: 30_000,
  retryMs: 60_000,
  stoppingMs: 2_000,
};

export class ProviderNotFound extends EngineError {
  override readonly name = 'ProviderNotFound';
  readonly code = 'not_found';
  constructor(id: string) {
    super(`There is no provider account ${id}`);
  }
}

export class InvalidSandbox extends EngineError {
  override readonly name = 'InvalidSandbox';
  readonly code = 'invalid_request';
}

/** The server was not set up with what a sandbox is made from, or with the provider at all. */
export class SandboxesUnavailable extends EngineError {
  override readonly name = 'SandboxesUnavailable';
  readonly code = 'unavailable';
}

/** The machine is not a sandbox. */
export class NotASandbox extends EngineError {
  override readonly name = 'NotASandbox';
  readonly code = 'not_found';
  constructor(id: string) {
    super(`The machine ${id} is not a sandbox`);
  }
}

/** A sandbox that a command needs is not there to run it. */
export class SandboxAsleep extends EngineError {
  override readonly name = 'SandboxAsleep';
  readonly code = 'sandbox_asleep';
}

export type CreateSandbox = {
  /** The account it is made in. */
  readonly provider: SandboxProviderId;
  readonly vcpu: number;
  readonly memoryGB: number;
  /** What the machine is called. One is made up without it. */
  readonly name?: string;
  /** The agents whose actors may work on it. None unless said. */
  readonly agents?: MachineAgents;
  readonly idleTimeoutSeconds?: number;
  /** Seconds the call waits for its daemon to connect. */
  readonly wait?: number;
};

/** What the engine remembers of a sandbox between two looks at it. It is not kept across a restart. */
type Kept = {
  /** When a command last started on it. */
  activity: number;
  /** When its idle time was last put off, and whether commands ran then. */
  setAt: number;
  ran: boolean;
  /** After a provider could not be asked: not before this. */
  retryAt: number;
};

/** A machine that is a sandbox its provider has answered for. */
type Made = StoredMachine & { readonly sandbox: StoredSandbox & { readonly sandboxId: string } };

const isMade = (machine: StoredMachine | undefined): machine is Made =>
  machine?.sandbox != null && machine.sandbox.sandboxId !== null;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export type SandboxesOptions = {
  readonly store: Store;
  readonly machines: Machines;
  /** The providers this engine makes sandboxes at. */
  readonly providers: readonly SandboxProvider[];
  /** Seals an account's key. Without it, an account that has a key is not taken. */
  readonly secrets?: Secrets;
  readonly id: (now: number) => SandboxProviderId;
  /** Where a sandbox's daemon reaches this engine, when it is not where the request came to. */
  readonly publicUrl?: string;
  readonly times?: Partial<SandboxTimes>;
  readonly clock?: () => number;
  readonly report?: (error: unknown) => void;
};

export class Sandboxes {
  readonly #store: Store;
  readonly #machines: Machines;
  readonly #providers: ReadonlyMap<string, SandboxProvider>;
  readonly #secrets: Secrets | undefined;
  readonly #id: (now: number) => SandboxProviderId;
  readonly #publicUrl: string | undefined;
  readonly #times: SandboxTimes;
  readonly #now: () => number;
  readonly #report: (error: unknown) => void;
  readonly #kept = new Map<MachineId, Kept>();
  /** The sandboxes the engine has stopped, or found gone: they are not asked to stop again. */
  readonly #asleep = new Set<MachineId>();
  /** After a stop that failed: not before this. */
  readonly #stopAfter = new Map<MachineId, number>();
  /** The wakes under way, so that two commands for one sandbox start it once. */
  readonly #waking = new Map<MachineId, Promise<void>>();
  /** What is being done to each sandbox at its provider, the last of it: one thing at a time. */
  readonly #queues = new Map<MachineId, Promise<void>>();
  readonly #tick: NodeJS.Timeout;
  #ticking = false;
  #closed = false;

  constructor(options: SandboxesOptions) {
    this.#store = options.store;
    this.#machines = options.machines;
    this.#providers = new Map(options.providers.map((provider) => [provider.kind, provider]));
    this.#secrets = options.secrets;
    this.#id = options.id;
    this.#publicUrl = options.publicUrl;
    this.#times = { ...DEFAULT_SANDBOX_TIMES, ...options.times };
    this.#now = options.clock ?? Date.now;
    this.#report =
      options.report ??
      ((error) => {
        console.error(error);
      });
    this.#tick = setInterval(() => {
      void this.keepAwake();
    }, this.#times.tickMs);
    this.#tick.unref();
  }

  close(): void {
    this.#closed = true;
    clearInterval(this.#tick);
  }

  /** The providers this engine was set up with, by what accounts of them say they are. */
  kinds(): string[] {
    return [...this.#providers.keys()];
  }

  // Accounts

  /** What an account's key is sealed as: it opens as no other account's. */
  static #bound(provider: SandboxProviderId): string {
    return `provider:${provider}`;
  }

  /** The provider an account is at, when this engine was set up with it. */
  #kind(kind: string): SandboxProvider {
    const provider = this.#providers.get(kind);
    if (provider === undefined) {
      throw new SandboxesUnavailable(
        `This server was not set up with the provider ${kind}, which the account is at`,
      );
    }
    return provider;
  }

  /** What an account's provider is asked with: its key, opened. */
  #account(row: StoredSandboxProvider): { provider: SandboxProvider; account: SandboxAccount } {
    const provider = this.#kind(row.kind);
    let credential: string | null = null;
    if (row.credential !== null) {
      if (this.#secrets === undefined) throw new SecretsUnavailable();
      credential = this.#secrets.open(
        Sandboxes.#bound(row.id),
        row.credential,
        `The key of the provider account ${row.id}`,
      );
    }
    return {
      provider,
      account: provider.account(credential, { requestMs: this.#times.requestMs }),
    };
  }

  async #provider(id: SandboxProviderId): Promise<StoredSandboxProvider> {
    const row = await this.#store.loadSandboxProvider(id);
    if (row === undefined) throw new ProviderNotFound(id);
    return row;
  }

  static #view(
    row: StoredSandboxProvider,
    machines: readonly StoredMachine[],
  ): SandboxProviderAccount {
    return {
      id: row.id,
      kind: row.kind,
      name: row.name as SandboxProviderAccount['name'],
      account: row.account,
      sandboxes: machines.filter((machine) => machine.sandbox?.provider === row.id).length,
      createdAt: row.createdAt,
    };
  }

  /** Every account, in the order they were added, never with its key. */
  async providers(): Promise<SandboxProviderAccount[]> {
    const machines = await this.#store.listMachines();
    return (await this.#store.listSandboxProviders()).map((row) => Sandboxes.#view(row, machines));
  }

  /**
   * Adds an account at a provider. Its key is checked with the provider before it is kept:
   * one the provider refuses is never stored. It is kept sealed, and is never given back.
   */
  async addProvider(given: {
    readonly kind: string;
    readonly name: string;
    readonly apiKey?: string;
  }): Promise<SandboxProviderAccount> {
    const provider = this.#providers.get(given.kind);
    if (provider === undefined) {
      const has = this.kinds();
      throw new InvalidSandbox(
        has.length === 0
          ? 'This server was set up with no provider of sandboxes'
          : `\`kind\` is a provider this server was set up with: ${has.join(', ')}`,
      );
    }
    let apiKey: string | null = null;
    if (provider.credential === 'api_key') {
      apiKey = given.apiKey?.trim() ?? '';
      if (!/^[\x21-\x7e]{1,512}$/.test(apiKey)) {
        throw new InvalidSandbox(`\`apiKey\` is the ${provider.label} API key of the account`);
      }
    } else if (given.apiKey !== undefined) {
      throw new InvalidSandbox(`An account at ${provider.label} has no API key`);
    }
    if ((await this.#store.listSandboxProviders()).some((one) => one.name === given.name)) {
      throw new NameTaken(given.name, 'provider account');
    }
    const now = this.#now();
    const id = this.#id(now);
    // Sealed first: a server that keeps no secrets takes no key, and asks the provider nothing.
    let credential: string | null = null;
    if (apiKey !== null) {
      if (this.#secrets === undefined) throw new SecretsUnavailable();
      credential = this.#secrets.seal(Sandboxes.#bound(id), apiKey);
    }
    const account = await provider.account(apiKey, { requestMs: this.#times.requestMs }).whoami();
    const row: StoredSandboxProvider = {
      id,
      kind: provider.kind,
      name: given.name,
      credential,
      account,
      createdAt: now,
    };
    await this.#store.addSandboxProvider(row);
    return Sandboxes.#view(row, []);
  }

  /** Forgets an account and its key. Not while it has sandboxes. */
  async removeProvider(id: SandboxProviderId): Promise<void> {
    const removed = await this.#store.removeSandboxProvider(id);
    if (removed === 'missing') throw new ProviderNotFound(id);
    if (removed === 'in_use') throw new Conflict("Remove this account's sandboxes first");
  }

  // Sandboxes

  async #info(
    stored: StoredMachine & { sandbox: StoredSandbox },
    kind: string,
    state: SandboxState,
  ): Promise<Sandbox> {
    return {
      machine: await this.#machines.get(stored.id),
      provider: stored.sandbox.provider,
      kind,
      providerSandboxId: stored.sandbox.sandboxId,
      vcpu: stored.sandbox.vcpu,
      memoryGB: stored.sandbox.memoryGB,
      idleTimeoutSeconds: stored.sandbox.idle,
      state,
    };
  }

  /** Whether a machine is a sandbox. */
  async is(machineId: MachineId): Promise<boolean> {
    return (await this.#store.loadMachine(machineId))?.sandbox != null;
  }

  /** An account's sandboxes, each with how it stands at the provider: `unknown` when that could not be asked. */
  async list(providerId: SandboxProviderId): Promise<Sandbox[]> {
    const row = await this.#provider(providerId);
    const machines = (await this.#store.listMachines()).filter(
      (machine): machine is StoredMachine & { sandbox: StoredSandbox } =>
        machine.sandbox?.provider === providerId,
    );
    let found: Map<string, ProviderSandbox> | null = new Map();
    if (machines.length > 0) {
      try {
        found = await this.#account(row).account.list(LABEL_PROVIDER, row.id);
      } catch {
        found = null;
      }
    }
    return Promise.all(
      machines.map((machine) => {
        const { sandboxId } = machine.sandbox;
        // One the provider has said nothing of is still being made, or is gone.
        const state: SandboxState =
          found === null
            ? 'unknown'
            : sandboxId === null
              ? 'starting'
              : (found.get(sandboxId)?.state ?? 'gone');
        return this.#info(machine, row.kind, state);
      }),
    );
  }

  /**
   * Makes a sandbox, as a machine. The machine is made first, so that its daemon is known the
   * moment it dials. The provider is given what the daemon enrols with, to put in the sandbox
   * before it starts. Resolves when the daemon has connected, or after the wait, with the
   * machine not yet online: it shows online when it connects.
   *
   * `origin` is where the request came to, for a server that was not told where it is reached.
   */
  async create(given: CreateSandbox, origin: string): Promise<Sandbox> {
    const row = await this.#provider(given.provider);
    const { provider, account } = this.#account(row);
    const wrong = provider.sizeProblem(given.vcpu, given.memoryGB);
    if (wrong !== undefined) throw new InvalidSandbox(wrong);
    const idle = given.idleTimeoutSeconds ?? DEFAULT_SANDBOX_IDLE_S;
    if (!Number.isInteger(idle) || idle < MIN_SANDBOX_IDLE_S || idle > MAX_SANDBOX_IDLE_S) {
      throw new InvalidSandbox(
        `\`idleTimeoutSeconds\` is a whole number from ${String(MIN_SANDBOX_IDLE_S)} to ${String(MAX_SANDBOX_IDLE_S)}`,
      );
    }
    const waitMs = given.wait === undefined ? this.#times.waitMs : given.wait * 1000;
    if (!(waitMs >= 0 && waitMs <= SANDBOX_WAIT_MAX_S * 1000)) {
      throw new InvalidSandbox(`\`wait\` is from 0 to ${String(SANDBOX_WAIT_MAX_S)} seconds`);
    }
    const unavailable = provider.unavailable?.();
    if (unavailable !== undefined) throw new SandboxesUnavailable(unavailable);

    const { machine, token } = await this.#machines.add({
      name: given.name ?? `sandbox-${randomBytes(4).toString('hex')}`,
      ...(given.agents === undefined ? {} : { agents: given.agents }),
    });
    const sandbox: StoredSandbox = {
      provider: row.id,
      sandboxId: null,
      vcpu: given.vcpu,
      memoryGB: given.memoryGB,
      idle,
      deadline: null,
    };
    let made: ProviderSandbox;
    // Its idle time starts when the provider handles the create: one counted from before is never later.
    const asked = this.#now();
    try {
      if (!(await this.#store.setSandbox(machine.id, sandbox))) throw new ProviderNotFound(row.id);
      const server = this.#publicUrl ?? origin;
      made = await account.create({
        machine: machine.id,
        name: machine.name,
        vcpu: given.vcpu,
        memoryGB: given.memoryGB,
        idleSeconds: idle,
        labels: { [LABEL_MACHINE]: machine.id, [LABEL_PROVIDER]: row.id },
        provision: JSON.stringify({
          server: provider.serverFor?.(server) ?? server,
          id: machine.id,
          token,
        }),
        // One of its own for each try: nothing of a try that failed is taken for this one.
        key: `${machine.id}-${randomBytes(8).toString('hex')}`,
      });
    } catch (error) {
      // The machine never had a sandbox. If the provider made one all the same, and its
      // answer was lost, nothing can enrol as it: what it would enrol with goes with the machine.
      await this.#machines.remove(machine.id).catch(() => {});
      throw error;
    }
    const kept = { ...sandbox, sandboxId: made.id, deadline: asked + idle * 1000 };
    const stored = await this.#store.changeMachine(machine.id, { sandbox: kept });
    if (stored === undefined) throw new MachineNotFound(machine.id);
    const online = await this.#machines.online(machine.id, waitMs);
    // A daemon that connected is running, whatever the provider said when it answered the create.
    return this.#info({ ...stored, sandbox: kept }, row.kind, online ? 'running' : made.state);
  }

  /**
   * Deletes a sandbox at its provider, disk included, and removes its machine. When the
   * provider cannot be asked nothing is removed, and the call is made again. A sandbox whose
   * account's credential the provider refuses cannot be deleted from here: its machine is
   * removed, and it is left at the provider.
   */
  async remove(machineId: MachineId): Promise<void> {
    const stored = await this.#store.loadMachine(machineId);
    if (stored === undefined) throw new MachineNotFound(machineId);
    if (stored.sandbox === null) throw new NotASandbox(machineId);
    const { provider, account } = this.#account(await this.#provider(stored.sandbox.provider));
    const { sandboxId } = stored.sandbox;
    await this.#exclusive(machineId, async () => {
      try {
        let ids: string[];
        if (sandboxId !== null) {
          ids = [sandboxId];
        } else {
          // A create whose answer never came, though the provider may have made it: found by its label.
          const found = await account.list(LABEL_MACHINE, machineId);
          ids = [...found.values()]
            .filter((one) => one.labels === undefined || one.labels[LABEL_MACHINE] === machineId)
            .map((one) => one.id);
        }
        for (const id of ids) await account.delete(id);
      } catch (error) {
        if (!(error instanceof ProviderFailed) || error.reason !== 'credential') {
          throw new ProviderFailed(
            `The sandbox could not be deleted at ${provider.label}, and nothing was removed: try again (${messageOf(error)})`,
            error instanceof ProviderFailed ? { status: error.status } : {},
          );
        }
        this.#report(
          new Error(
            `The sandbox of ${machineId} was left at ${provider.label}: it refused the account's credential`,
          ),
        );
      }
      this.#forget(machineId);
      await this.#machines.remove(machineId);
    });
  }

  #forget(machineId: MachineId): void {
    this.#kept.delete(machineId);
    this.#asleep.delete(machineId);
    this.#stopAfter.delete(machineId);
  }

  // Sleeping and waking

  /** Does `work` once everything asked of this sandbox's provider before it is done. */
  #exclusive<T>(machine: MachineId, work: () => Promise<T>): Promise<T> {
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

  #keptOf(machineId: MachineId): Kept {
    let kept = this.#kept.get(machineId);
    if (kept === undefined) {
      kept = { activity: 0, setAt: 0, ran: false, retryAt: 0 };
      this.#kept.set(machineId, kept);
    }
    return kept;
  }

  /** Writes down when a sandbox's idle time runs out. */
  async #deadline(machineId: MachineId, deadline: number): Promise<void> {
    const now = await this.#store.loadMachine(machineId);
    if (now?.sandbox == null) return;
    await this.#store.changeMachine(machineId, { sandbox: { ...now.sandbox, deadline } });
  }

  /**
   * Puts off the moment a sandbox's idle time runs out: at a provider that stops sandboxes
   * itself, its timer is set again. And writes down when that moment now is.
   */
  async #touch(provider: SandboxProvider, account: SandboxAccount, made: Made): Promise<void> {
    const asked = this.#now();
    if (provider.idle === 'provider') {
      if (account.keepFor === undefined) {
        throw new Error(`${provider.label} stops its sandboxes itself, and has no keepFor`);
      }
      await account.keepFor(made.sandbox.sandboxId, made.sandbox.idle);
    }
    await this.#deadline(made.id, asked + made.sandbox.idle * 1000);
  }

  /**
   * Before a command: makes sure the machine, when it is a sandbox, is awake and will stay
   * up. One that is connected, with an idle time far from running out, is used as it is.
   * Otherwise its provider is asked: a running sandbox has its idle time put off, a stopped
   * one is started, and the call waits for its daemon to connect. Rejects with
   * `SandboxAsleep` when it cannot be had. Resolves at once for a machine that is not a sandbox.
   */
  async wake(machineId: MachineId): Promise<void> {
    const stored = await this.#store.loadMachine(machineId);
    if (!isMade(stored)) return;
    // A command is starting on it: its idle time is put off soon, whatever is found here.
    this.#keptOf(machineId).activity = this.#now();
    const { deadline } = stored.sandbox;
    if (
      this.#machines.onlineSince(machineId) !== undefined &&
      deadline !== null &&
      this.#now() < deadline - this.#times.marginMs
    ) {
      return;
    }
    const under = this.#waking.get(machineId);
    if (under !== undefined) return under;
    const waking = this.#exclusive(machineId, () => this.#wake(machineId)).finally(() => {
      this.#waking.delete(machineId);
    });
    this.#waking.set(machineId, waking);
    return waking;
  }

  async #wake(machineId: MachineId): Promise<void> {
    // As it is now: it may have been stopped, or removed, while this waited its turn.
    const made = await this.#store.loadMachine(machineId);
    if (!isMade(made)) return;
    const { sandboxId, idle } = made.sandbox;
    const online = this.#machines.onlineSince(machineId) !== undefined;
    let provider: SandboxProvider;
    let account: SandboxAccount;
    let state: SandboxState;
    try {
      ({ provider, account } = this.#account(await this.#provider(made.sandbox.provider)));
      state = await account.state(sandboxId);
    } catch (error) {
      throw new SandboxAsleep(
        `Your machine, ${made.name}, is a sandbox, and its provider could not be asked about it: ${messageOf(error)}. Nothing was run.`,
      );
    }
    const asleep = new SandboxAsleep(
      `Your machine, ${made.name}, is a sandbox that is still starting up: nothing was run. Try again shortly.`,
    );
    try {
      switch (state) {
        case 'gone':
          this.#asleep.add(machineId);
          throw new SandboxAsleep(
            `Your machine, ${made.name}, was a sandbox, and it no longer exists: nothing was run.`,
          );
        case 'running':
          await this.#touch(provider, account, made);
          this.#asleep.delete(machineId);
          if (online || (await this.#machines.online(machineId, this.#times.wakeMs))) return;
          throw asleep;
        case 'starting':
          if (await this.#machines.online(machineId, this.#times.wakeMs)) {
            await this.#touch(provider, account, made);
            this.#asleep.delete(machineId);
            return;
          }
          throw asleep;
        default: {
          // Stopped, stopping or failed: it is started again. One that is still saving its
          // disk holds the machine for a moment, and its provider says to try again.
          const began = Date.now();
          const until = began + this.#times.wakeMs;
          let asked: number;
          let started: boolean;
          for (;;) {
            try {
              asked = this.#now();
              started = await account.start(sandboxId, idle);
              break;
            } catch (error) {
              const busy = error instanceof ProviderFailed && error.reason === 'busy';
              if (!busy || Date.now() >= until) throw error;
              await new Promise((resolve) => setTimeout(resolve, this.#times.stoppingMs));
            }
          }
          this.#asleep.delete(machineId);
          // Only a start this call made puts the idle time off to a moment it knows.
          if (started) await this.#deadline(machineId, asked + idle * 1000);
          // A connection from before it stopped can look live for a while: only one made
          // since counts.
          if (await this.#machines.online(machineId, this.#times.wakeMs, began)) return;
          throw asleep;
        }
      }
    } catch (error) {
      if (error instanceof SandboxAsleep) throw error;
      throw new SandboxAsleep(
        `Your machine, ${made.name}, is a sandbox that could not be started: ${messageOf(error)}. Nothing was run.`,
      );
    }
  }

  /** When a sandbox's idle time is next to be put off. Undefined when it is not. */
  #due(idle: number, kept: Kept, running: boolean, now: number): number | undefined {
    const interval = Math.min(
      this.#times.maxIntervalMs,
      Math.max(this.#times.minIntervalMs, idle * 500),
    );
    let due: number | undefined;
    // While any command runs: every half of the idle time. Once more when the last ends.
    if (running) due = kept.setAt === 0 ? now : kept.setAt + interval;
    else if (kept.ran) due = now;
    // A command started since it was last put off: soon, and not at every command.
    if (kept.activity > kept.setAt) {
      const soon = Math.max(kept.activity, kept.setAt + this.#times.debounceMs);
      due = due === undefined ? soon : Math.min(due, soon);
    }
    return due === undefined ? undefined : Math.max(due, kept.retryAt);
  }

  /**
   * Puts off the idle times that are due, and stops the sandboxes whose idle time has run
   * out, where that is the engine's to do. It runs by itself every few seconds, and a test
   * calls it to have it happen now.
   */
  async keepAwake(): Promise<void> {
    if (this.#ticking || this.#closed) return;
    this.#ticking = true;
    try {
      for (const made of (await this.#store.listMachines()).filter(isMade)) {
        if (this.#closed) return;
        const row = await this.#store.loadSandboxProvider(made.sandbox.provider);
        // An account of a provider this server is no longer set up with is left as it is.
        if (row === undefined || !this.#providers.has(row.kind)) continue;
        const running = (await this.#machines.busy(made.id)) > 0;
        await this.#putOff(row, made, running);
        if (this.#providers.get(row.kind)?.idle === 'engine' && !running) {
          await this.#sleep(row, made.id);
        }
      }
    } catch (error) {
      if (!this.#closed) this.#report(error);
    } finally {
      this.#ticking = false;
    }
  }

  async #putOff(row: StoredSandboxProvider, made: Made, running: boolean): Promise<void> {
    // One nothing was run on since the engine started, and that runs nothing, is left to sleep.
    if (!this.#kept.has(made.id) && !running) return;
    const kept = this.#keptOf(made.id);
    const now = this.#now();
    const due = this.#due(made.sandbox.idle, kept, running, now);
    if (due === undefined || due > now) return;
    try {
      const { provider, account } = this.#account(row);
      await this.#touch(provider, account, made);
      kept.setAt = now;
      kept.ran = running;
      kept.retryAt = 0;
    } catch (error) {
      // Its provider no longer has it: there is no idle time to put off.
      if (error instanceof ProviderFailed && error.reason === 'gone') {
        this.#kept.delete(made.id);
        return;
      }
      this.#report(
        new Error(
          `The idle time of the sandbox ${made.name} could not be put off: it is tried again`,
          { cause: error },
        ),
      );
      kept.retryAt = this.#now() + this.#times.retryMs;
    }
  }

  /** Stops a sandbox whose idle time has run out with nothing running on it, in its turn. */
  async #sleep(row: StoredSandboxProvider, machineId: MachineId): Promise<void> {
    const due = (machine: StoredMachine | undefined): machine is Made =>
      isMade(machine) &&
      machine.sandbox.deadline !== null &&
      this.#now() >= machine.sandbox.deadline &&
      !this.#asleep.has(machineId) &&
      this.#now() >= (this.#stopAfter.get(machineId) ?? 0);
    if (!due(await this.#store.loadMachine(machineId))) return;
    await this.#exclusive(machineId, async () => {
      // As it is now: a command may have woken it while this waited its turn.
      const made = await this.#store.loadMachine(machineId);
      if (!due(made) || (await this.#machines.busy(machineId)) > 0) return;
      try {
        const { provider, account } = this.#account(row);
        if (account.stop === undefined) {
          throw new Error(
            `${provider.label} leaves stopping its sandboxes to the engine, and has no stop`,
          );
        }
        await account.stop(made.sandbox.sandboxId);
        this.#asleep.add(machineId);
        this.#kept.delete(machineId);
        this.#stopAfter.delete(machineId);
      } catch (error) {
        if (error instanceof ProviderFailed && error.reason === 'gone') {
          this.#asleep.add(machineId);
          return;
        }
        this.#report(
          new Error(`The sandbox ${made.name} could not be stopped: it is tried again`, {
            cause: error,
          }),
        );
        this.#stopAfter.set(machineId, this.#now() + this.#times.retryMs);
      }
    });
  }
}
