// What the local runner keeps, and the store interface any backend
// implements to keep it.
//
// The interface is shaped around what the runner does. `commit` is the one
// operation that must be atomic: when it resolves, everything in the step is
// saved, and if it throws, none of it is. Every other write is a single
// record. Opening a store takes it for one runner: a second runner opening
// the same store fails with 'locked' until the first closes it.

import type {
  EffectRequest,
  JournalEntry,
  Json,
  JsonObject,
  LogEntry,
  Mode,
  Outcome,
} from '@acentric/types';

/** Names an agent's code. */
export type AgentRef = { name: string; version: string };

/**
 * A kind's settings: read from the bundle's handlers when it is deployed, or
 * given at deploy time for a kind an application provides.
 */
export type KindInfo = {
  mode: Mode;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Set for a kind an application provides rather than the bundle's handlers. */
  provided?: true;
};

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

export type SessionRecord = {
  id: string;
  agent: AgentRef;
  config: JsonObject;
  snapshot: JsonObject;
  /** The seq the next log entry gets. */
  nextSeq: number;
  /** Why the session stopped taking messages, or null. */
  fault: string | null;
  /** Identifies what created the session, so creating it again can be recognised. */
  createHash: string;
  createdAt: number;
};

export type LoadedSession = SessionRecord & {
  /** Declared, unfinished effects, in the order they started. */
  running: StoredEffect[];
  /** The `n` the next journal entry gets, or null for a session that keeps no journal. */
  nextEntry: number | null;
};

/** What a new session starts with, saved with it. */
export type SessionStart = {
  append: LogEntry[];
  started: StoredEffect[];
  /** Its journal so far: the init entry, or the entries a fork copies. Empty keeps no journal. */
  journal: JournalEntry[];
  /** Keys that already finished, for a fork. */
  finished?: string[];
  /** Answered requests, for a fork. */
  requests?: RequestRecord[];
  /** The request that created it. */
  request?: RequestRecord;
};

export type JournalRange = {
  /** Only entries with an `n` greater than this. */
  after?: number;
  limit?: number;
};

export type SessionSummary = {
  id: string;
  agent: AgentRef;
  nextSeq: number;
  fault: string | null;
  running: number;
  createdAt: number;
};

export type SessionFilter = {
  agent?: string;
  faulted?: boolean;
  /** Only sessions whose id sorts after this one, for paging. */
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
  /** The session's nextSeq the step was computed from; the commit fails if it moved. */
  expectedSeq: number;
  snapshot: JsonObject;
  /** The new config, for a config change or an upgrade. */
  config?: JsonObject;
  /** The new agent, for an upgrade. */
  agent?: AgentRef;
  /** Clears the session's fault, for an upgrade. */
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
  /** The journal entry for this change, for a session that keeps a journal. */
  journal?: JournalEntry;
};

export type StoreErrorCode =
  'locked' | 'bundle_conflict' | 'session_exists' | 'no_session' | 'stale_commit' | 'invalid';

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
  listBundles(): Promise<(AgentRef & { hash: string; sessions: number })[]>;
  /** Removes a bundle. The runner removes only bundles no session uses. */
  deleteBundle(ref: AgentRef): Promise<void>;

  /** Saves a new session with its init step or forked state, atomically. Refuses an id already used. */
  create(session: SessionRecord, start: SessionStart): Promise<void>;
  load(id: string): Promise<LoadedSession | null>;
  list(filter?: SessionFilter): Promise<SessionSummary[]>;
  /** Ids of sessions with running effects or inbox items: what recovery looks at. */
  pending(): Promise<string[]>;

  /** Saves a step, atomically. */
  commit(id: string, step: StepCommit): Promise<void>;
  readLog(id: string, range?: LogRange): Promise<LogEntry[]>;
  /** A session's journal entries, oldest first. */
  readJournal(id: string, range?: JournalRange): Promise<JournalEntry[]>;
  /**
   * Saves a journal entry for a step that changed nothing, atomically with
   * the answer to its request or the fault it caused.
   */
  record(
    id: string,
    entry: JournalEntry,
    alongside: { request?: RequestRecord; fault?: string },
  ): Promise<void>;
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
