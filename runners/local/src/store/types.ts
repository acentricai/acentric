// What the local runner keeps, and the store interface any backend
// implements to keep it.
//
// The interface is shaped around what the runner does. `commit` is the one
// operation that must be atomic: when it resolves, everything in the step is
// saved, and if it throws, none of it is. Every other write is a single
// record. Opening a store takes it for one runner: a second runner opening
// the same store fails with 'locked' until the first closes it.

import type { EffectRequest, Json, JsonObject, LogEntry, Mode, Outcome } from '@acentric/types';

/** Names an agent's code. */
export type AgentRef = { name: string; version: string };

/** A handler kind's settings, read from the bundle's handlers when it is deployed. */
export type KindInfo = { mode: Mode; timeoutMs?: number; maxAttempts?: number };

/** An agent's code, as deployed. Code under a name and version never changes. */
export type Bundle = AgentRef & {
  /** Identifies the code: two bundles with the same hash are the same. */
  hash: string;
  /** The agent module's source: an ES module whose default export is the pure half. */
  agent: string;
  /** The handlers module's source: an ES module whose default export is the handlers. */
  handlers: string;
  /** The kinds the handlers module provides, and their settings. */
  kinds: Record<string, KindInfo>;
};

/** An effect that was declared and has not finished. */
export type StoredEffect = {
  request: EffectRequest;
  mode: Mode;
  /** Runs of this key so far, counting the current one. */
  attempt: number;
};

export type InstanceRecord = {
  id: string;
  agent: AgentRef;
  config: JsonObject;
  snapshot: JsonObject;
  /** The seq the next log entry gets. */
  nextSeq: number;
  /** Why the instance stopped taking messages, or null. */
  fault: string | null;
  /** Identifies what created the instance, so creating it again can be recognised. */
  createHash: string;
  createdAt: number;
};

export type LoadedInstance = InstanceRecord & {
  /** Declared, unfinished effects, in the order they started. */
  running: StoredEffect[];
};

export type InstanceSummary = {
  id: string;
  agent: AgentRef;
  nextSeq: number;
  fault: string | null;
  running: number;
  createdAt: number;
};

export type InstanceFilter = {
  agent?: string;
  faulted?: boolean;
  /** Only instances whose id sorts after this one, for paging. */
  after?: string;
  limit?: number;
};

/** A caller's request the runner answered, kept so a retry gets the same answer. */
export type RequestRecord = {
  id: string;
  /** Identifies the request's content, so a different request under the same id is refused. */
  hash: string;
  answer: Json;
};

/** An effect's outcome, saved when its handler finished and waiting for its step. */
export type InboxItem = { ord: number; key: string; outcome: Outcome };

export type LogRange = {
  after?: number;
  before?: number;
  kinds?: readonly string[];
  limit?: number;
};

/** Everything one step changes, saved together. */
export type StepCommit = {
  /** The instance's nextSeq the step was computed from; the commit fails if it moved. */
  expectedSeq: number;
  snapshot: JsonObject;
  /** The new config, for a config change or an upgrade. */
  config?: JsonObject;
  /** The new agent, for an upgrade. */
  agent?: AgentRef;
  /** Clears the instance's fault, for an upgrade. */
  clearFault?: true;
  /** Entries numbered from expectedSeq with no gaps. */
  append: LogEntry[];
  started: StoredEffect[];
  /** Keys that finished or were cancelled; they never run again. */
  finished: string[];
  /** Keys whose abort flag is now set. */
  aborted: string[];
  /** The inbox item this step processed. */
  consumed?: number;
  /** The caller's request this step answered. */
  request?: RequestRecord;
};

export type StoreErrorCode =
  'locked' | 'bundle_conflict' | 'instance_exists' | 'no_instance' | 'stale_commit' | 'invalid';

export class StoreError extends Error {
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

export type Store = {
  /** Saves a bundle; 'exists' if the same bundle is already saved. Refuses a different one under the same name and version. */
  putBundle(bundle: Bundle): Promise<'stored' | 'exists'>;
  getBundle(ref: AgentRef): Promise<Bundle | null>;
  listBundles(): Promise<(AgentRef & { hash: string; instances: number })[]>;

  /** Saves a new instance with its init step, atomically. Refuses an id already used. */
  create(
    instance: InstanceRecord,
    init: { append: LogEntry[]; started: StoredEffect[]; request?: RequestRecord },
  ): Promise<void>;
  load(id: string): Promise<LoadedInstance | null>;
  list(filter?: InstanceFilter): Promise<InstanceSummary[]>;
  /** Ids of instances with running effects or inbox items: what recovery looks at. */
  pending(): Promise<string[]>;

  /** Saves a step, atomically. */
  commit(id: string, step: StepCommit): Promise<void>;
  readLog(id: string, range?: LogRange): Promise<LogEntry[]>;
  /** Which of `keys` finished. */
  findFinished(id: string, keys: readonly string[]): Promise<Set<string>>;

  findRequest(id: string, requestId: string): Promise<RequestRecord | null>;
  /** Saves an answer given without a step, such as a rejection. */
  putRequest(id: string, request: RequestRecord): Promise<void>;

  /** Saves a finished effect's outcome; returns its place in the inbox. */
  putResult(id: string, key: string, outcome: Outcome): Promise<number>;
  inbox(id: string): Promise<InboxItem[]>;
  /** Removes an inbox item without a step, for a result whose key was cancelled while it waited. */
  dropResult(id: string, ord: number): Promise<void>;
  recordAttempt(id: string, key: string, attempt: number): Promise<void>;
  setFault(id: string, fault: string): Promise<void>;
  delete(id: string): Promise<void>;

  close(): Promise<void>;
};
