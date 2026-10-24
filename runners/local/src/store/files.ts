// A store in a folder of plain files, for people who want to read, tail,
// grep and back up what their agents keep.
//
//   lock                                   the pid of the runner that has the store open
//   agents/<name>/<version>/               bundle.json (hash and kinds), agent.js, handlers.js
//   sessions/<id>/journal.jsonl           one line per write, oldest first
//   sessions/<id>/checkpoint.json         the session as of a place in its journal
//
// Every change to a session is one line appended to its journal, then
// synced to disk: a whole commit is one line, so it is saved entirely or
// not at all. A line starts with a checksum of its record. A crash can leave
// a last line half written; opening the session again cuts it off. Any
// other bad line means the journal was damaged, and the store refuses it.
//
// A session's replay journal, the entries the runner records for replaying
// it, travels in the same lines: a creation or commit line carries its entry,
// and an `entry` line records a step that changed nothing. An index of which
// lines hold which entries lets them be read back like the log.
//
// A session's state is rebuilt from its latest checkpoint and the journal
// lines after it, and kept in memory while the store is open. Log entries
// stay on disk: an index of which journal lines hold which seqs lets a range
// be read without the rest. A checkpoint is written every so many lines, so
// opening a session does not replay its whole history.
//
// New sessions and bundles are written to a temporary folder and renamed
// into place, so they appear whole. The lock file holds the pid of the
// runner that has the store open; a lock left by a process that is gone is
// taken over.

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import type { JournalEntry, LogEntry, Outcome } from '@acentric/types';

import { StoreError } from './types.js';
import type {
  AgentRef,
  Bundle,
  InboxItem,
  JournalRange,
  SessionFilter,
  SessionRecord,
  SessionStart,
  SessionSummary,
  KindInfo,
  LoadedSession,
  LogRange,
  RequestRecord,
  StepCommit,
  Store,
  StoredEffect,
} from './types.js';

export type FileStoreOptions = {
  /** Journal lines between checkpoints. Defaults to 500. */
  checkpointEvery?: number;
};

/** Opens, or creates, the store in the folder at `dir`. */
export function openFileStore(dir: string, options: FileStoreOptions = {}): Promise<Store> {
  try {
    return Promise.resolve(new FileStore(dir, options.checkpointEvery ?? 500));
  } catch (error) {
    return Promise.reject(
      error instanceof StoreError ? error : new StoreError('invalid', String(error)),
    );
  }
}

/** One line of a journal. */
type JournalRecord =
  | ({ t: 'create'; session: SessionRecord } & Omit<SessionStart, 'journal'> & {
        /** Absent in lines written before journals: such a session keeps none. */
        journal?: JournalEntry[];
      })
  | { t: 'commit'; step: StepCommit }
  | { t: 'entry'; entry: JournalEntry; request?: RequestRecord; fault?: string }
  | { t: 'result'; ord: number; key: string; outcome: Outcome }
  | { t: 'drop'; ord: number }
  | { t: 'attempt'; key: string; attempt: number }
  | { t: 'fault'; fault: string }
  | { t: 'request'; request: RequestRecord };

/** Where a journal line with log entries is, and which seqs it holds. */
type LineIndex = { offset: number; length: number; firstSeq: number; count: number };

/** Where a journal line with replay journal entries is, and which `n`s it holds. */
type EntryIndex = { offset: number; length: number; firstN: number; count: number };

/** A session as its journal says it is now. */
type SessionState = {
  record: SessionRecord;
  running: Map<string, StoredEffect>;
  finished: Set<string>;
  requests: Map<string, RequestRecord>;
  inbox: Map<number, InboxItem>;
  nextOrd: number;
  lines: LineIndex[];
  entryLines: EntryIndex[];
  /** The `n` the next replay journal entry gets, or null for a session that keeps none. */
  nextEntry: number | null;
  /** The journal's length, where the next line goes. */
  size: number;
  /** Lines written since the last checkpoint. */
  sinceCheckpoint: number;
};

type Checkpoint = {
  offset: number;
  record: SessionRecord;
  running: StoredEffect[];
  finished: string[];
  requests: RequestRecord[];
  inbox: InboxItem[];
  nextOrd: number;
  lines: LineIndex[];
  /** Absent in checkpoints written before journals. */
  entryLines?: EntryIndex[];
  nextEntry?: number | null;
};

class FileStore implements Store {
  readonly #dir: string;
  readonly #checkpointEvery: number;
  readonly #states = new Map<string, SessionState>();
  readonly #journals = new Map<string, number>();
  #scanned = false;
  #open = true;

  constructor(dir: string, checkpointEvery: number) {
    this.#dir = dir;
    this.#checkpointEvery = checkpointEvery;
    mkdirSync(join(dir, 'agents'), { recursive: true });
    mkdirSync(join(dir, 'sessions'), { recursive: true });
    this.#lock();
  }

  // ---- bundles --------------------------------------------------------------

  putBundle(bundle: Bundle): Promise<'stored' | 'exists'> {
    return this.#run(() => {
      const existing = this.#readBundle(bundle);
      if (existing !== null) {
        if (existing.hash === bundle.hash) return 'exists';
        throw new StoreError(
          'bundle_conflict',
          `different code is already deployed as ${bundle.name}@${bundle.version}`,
        );
      }
      const temporary = join(this.#dir, 'agents', `.tmp-${randomUUID()}`);
      mkdirSync(temporary);
      writeDurably(join(temporary, 'agent.js'), bundle.agent);
      writeDurably(join(temporary, 'handlers.js'), bundle.handlers);
      writeDurably(
        join(temporary, 'bundle.json'),
        JSON.stringify({ hash: bundle.hash, kinds: bundle.kinds }),
      );
      mkdirSync(join(this.#dir, 'agents', safe(bundle.name)), { recursive: true });
      renameSync(temporary, this.#bundleDir(bundle));
      syncDir(join(this.#dir, 'agents', safe(bundle.name)));
      return 'stored';
    });
  }

  getBundle(ref: AgentRef): Promise<Bundle | null> {
    return this.#run(() => this.#readBundle(ref));
  }

  listBundles(): Promise<(AgentRef & { hash: string; sessions: number })[]> {
    return this.#run(() => {
      const counts = new Map<string, number>();
      for (const state of this.#all()) {
        const id = `${state.record.agent.name}@${state.record.agent.version}`;
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      const bundles: (AgentRef & { hash: string; sessions: number })[] = [];
      for (const nameDir of names(join(this.#dir, 'agents'))) {
        for (const versionDir of names(join(this.#dir, 'agents', nameDir))) {
          const ref = { name: unsafe(nameDir), version: unsafe(versionDir) };
          const bundle = this.#readBundle(ref);
          if (bundle !== null) {
            bundles.push({
              ...ref,
              hash: bundle.hash,
              sessions: counts.get(`${ref.name}@${ref.version}`) ?? 0,
            });
          }
        }
      }
      return bundles.toSorted((a, b) => compare(a.name, b.name) || compare(a.version, b.version));
    });
  }

  deleteBundle(ref: AgentRef): Promise<void> {
    return this.#run(() => {
      const dir = this.#bundleDir(ref);
      if (!existsSync(dir)) return;
      const doomed = join(this.#dir, 'agents', `.tmp-${randomUUID()}`);
      renameSync(dir, doomed);
      rmSync(doomed, { recursive: true, force: true });
    });
  }

  // ---- sessions ------------------------------------------------------------

  create(session: SessionRecord, init: SessionStart): Promise<void> {
    return this.#run(() => {
      const dir = this.#sessionDir(session.id);
      if (existsSync(dir))
        throw new StoreError('session_exists', `session ${session.id} already exists`);
      checkDense(init.append, session.nextSeq);
      const record: JournalRecord = { t: 'create', session, ...init };
      const line = encode(record);
      const temporary = join(this.#dir, 'sessions', `.tmp-${randomUUID()}`);
      mkdirSync(temporary);
      writeDurably(join(temporary, 'journal.jsonl'), line);
      renameSync(temporary, dir);
      syncDir(join(this.#dir, 'sessions'));
      const state = emptyState(session);
      apply(state, record, 0, Buffer.byteLength(line));
      this.#states.set(session.id, state);
    });
  }

  load(id: string): Promise<LoadedSession | null> {
    return this.#run(() => {
      const state = this.#state(id);
      return state === null
        ? null
        : { ...state.record, running: [...state.running.values()], nextEntry: state.nextEntry };
    });
  }

  list(filter: SessionFilter = {}): Promise<SessionSummary[]> {
    return this.#run(() => {
      const after = filter.after;
      const matching = this.#all()
        .filter(
          (state) =>
            (filter.agent === undefined || state.record.agent.name === filter.agent) &&
            (filter.faulted === undefined || (state.record.fault !== null) === filter.faulted) &&
            (after === undefined || state.record.id > after),
        )
        .toSorted((a, b) => compare(a.record.id, b.record.id))
        .map((state) => ({
          id: state.record.id,
          agent: state.record.agent,
          nextSeq: state.record.nextSeq,
          fault: state.record.fault,
          running: state.running.size,
          createdAt: state.record.createdAt,
        }));
      return filter.limit === undefined ? matching : matching.slice(0, filter.limit);
    });
  }

  pending(): Promise<string[]> {
    return this.#run(() =>
      this.#all()
        .filter((state) => state.running.size > 0 || state.inbox.size > 0)
        .map((state) => state.record.id)
        .toSorted(compare),
    );
  }

  // ---- steps ----------------------------------------------------------------

  commit(id: string, step: StepCommit): Promise<void> {
    return this.#run(() => {
      const state = this.#require(id);
      if (state.record.nextSeq !== step.expectedSeq) {
        throw new StoreError(
          'stale_commit',
          `session ${id} has moved past seq ${step.expectedSeq}`,
        );
      }
      checkDense(step.append, step.expectedSeq);
      for (const key of step.finished) {
        if (!state.running.has(key))
          throw new StoreError('invalid', `effect ${key} of ${id} is not running`);
      }
      const finishing = new Set(step.finished);
      for (const effect of step.started) {
        const key = effect.request.key;
        if ((state.running.has(key) && !finishing.has(key)) || state.finished.has(key)) {
          throw new StoreError('invalid', `effect ${key} of ${id} was already declared`);
        }
      }
      if (step.consumed !== undefined && !state.inbox.has(step.consumed)) {
        throw new StoreError('invalid', `inbox item ${step.consumed} of ${id} does not exist`);
      }
      if (step.request !== undefined && state.requests.has(step.request.id)) {
        throw new StoreError('invalid', `request ${step.request.id} of ${id} was already answered`);
      }
      this.#append(id, state, { t: 'commit', step });
    });
  }

  readLog(id: string, range: LogRange = {}): Promise<LogEntry[]> {
    return this.#run(() => {
      const state = this.#state(id);
      if (state === null) return [];
      if (range.kinds !== undefined && range.kinds.length === 0) return [];
      const after = range.after ?? 0;
      const before = range.before ?? Number.POSITIVE_INFINITY;
      const kinds = range.kinds === undefined ? null : new Set(range.kinds);
      const limit = range.limit ?? Number.POSITIVE_INFINITY;
      const found: LogEntry[] = [];
      const fd = this.#journal(id);
      for (const line of state.lines) {
        if (line.firstSeq + line.count - 1 <= after) continue;
        if (line.firstSeq >= before || found.length >= limit) break;
        for (const entry of entriesOf(readRecord(fd, line))) {
          if (entry.seq <= after || entry.seq >= before) continue;
          if (kinds !== null && !kinds.has(entry.kind)) continue;
          found.push(entry);
          if (found.length >= limit) break;
        }
      }
      return found;
    });
  }

  readJournal(id: string, range: JournalRange = {}): Promise<JournalEntry[]> {
    return this.#run(() => {
      const state = this.#state(id);
      if (state === null) return [];
      const after = range.after ?? 0;
      const limit = range.limit ?? Number.POSITIVE_INFINITY;
      const found: JournalEntry[] = [];
      const fd = this.#journal(id);
      for (const line of state.entryLines) {
        if (found.length >= limit) break;
        if (line.firstN + line.count - 1 <= after) continue;
        for (const entry of journalEntriesOf(readRecord(fd, line))) {
          if (entry.n <= after) continue;
          found.push(entry);
          if (found.length >= limit) break;
        }
      }
      return found;
    });
  }

  record(
    id: string,
    entry: JournalEntry,
    alongside: { request?: RequestRecord; fault?: string },
  ): Promise<void> {
    return this.#run(() => {
      const state = this.#require(id);
      if (alongside.request !== undefined && state.requests.has(alongside.request.id)) {
        throw new StoreError(
          'invalid',
          `request ${alongside.request.id} of ${id} was already answered`,
        );
      }
      this.#append(id, state, { t: 'entry', entry, ...alongside });
    });
  }

  findFinished(id: string, keys: readonly string[]): Promise<Set<string>> {
    return this.#run(() => {
      const state = this.#state(id);
      return new Set(state === null ? [] : keys.filter((key) => state.finished.has(key)));
    });
  }

  // ---- requests -------------------------------------------------------------

  findRequest(id: string, requestId: string): Promise<RequestRecord | null> {
    return this.#run(() => this.#state(id)?.requests.get(requestId) ?? null);
  }

  putRequest(id: string, request: RequestRecord): Promise<void> {
    return this.#run(() => {
      const state = this.#require(id);
      if (state.requests.has(request.id)) {
        throw new StoreError('invalid', `request ${request.id} of ${id} was already answered`);
      }
      this.#append(id, state, { t: 'request', request });
    });
  }

  // ---- effects between steps ------------------------------------------------

  putResult(id: string, key: string, outcome: Outcome): Promise<number> {
    return this.#run(() => {
      const state = this.#require(id);
      const ord = state.nextOrd;
      this.#append(id, state, { t: 'result', ord, key, outcome });
      return ord;
    });
  }

  inbox(id: string): Promise<InboxItem[]> {
    return this.#run(() => [...(this.#state(id)?.inbox.values() ?? [])]);
  }

  dropResult(id: string, ord: number): Promise<void> {
    return this.#run(() => {
      const state = this.#state(id);
      if (state?.inbox.has(ord) === true) this.#append(id, state, { t: 'drop', ord });
    });
  }

  recordAttempt(id: string, key: string, attempt: number): Promise<void> {
    return this.#run(() => {
      const state = this.#state(id);
      if (state?.running.has(key) === true) this.#append(id, state, { t: 'attempt', key, attempt });
    });
  }

  setFault(id: string, fault: string): Promise<void> {
    return this.#run(() => {
      const state = this.#state(id);
      if (state !== null) this.#append(id, state, { t: 'fault', fault });
    });
  }

  delete(id: string): Promise<void> {
    return this.#run(() => {
      const dir = this.#sessionDir(id);
      this.#closeJournal(id);
      this.#states.delete(id);
      if (!existsSync(dir)) return;
      const doomed = join(this.#dir, 'sessions', `.tmp-${randomUUID()}`);
      renameSync(dir, doomed);
      rmSync(doomed, { recursive: true, force: true });
    });
  }

  close(): Promise<void> {
    if (this.#open) {
      this.#open = false;
      for (const id of this.#journals.keys()) this.#closeJournal(id);
      this.#states.clear();
      const lock = join(this.#dir, 'lock');
      if (readPid(lock) === process.pid) unlinkSync(lock);
    }
    return Promise.resolve();
  }

  // ---- journals -------------------------------------------------------------

  /** Appends one record to a session's journal, syncs it, then applies it. */
  #append(id: string, state: SessionState, record: JournalRecord): void {
    const fd = this.#journal(id);
    const line = encode(record);
    const bytes = Buffer.from(line);
    let written = 0;
    while (written < bytes.length)
      written += writeSync(fd, bytes, written, bytes.length - written, state.size + written);
    fsyncSync(fd);
    apply(state, record, state.size, bytes.length);
    state.sinceCheckpoint += 1;
    if (state.sinceCheckpoint >= this.#checkpointEvery) this.#checkpoint(id, state);
  }

  #checkpoint(id: string, state: SessionState): void {
    const checkpoint: Checkpoint = {
      offset: state.size,
      record: state.record,
      running: [...state.running.values()],
      finished: [...state.finished],
      requests: [...state.requests.values()],
      inbox: [...state.inbox.values()],
      nextOrd: state.nextOrd,
      lines: state.lines,
      entryLines: state.entryLines,
      nextEntry: state.nextEntry,
    };
    const path = join(this.#sessionDir(id), 'checkpoint.json');
    const temporary = `${path}.tmp`;
    writeDurably(temporary, JSON.stringify(checkpoint));
    renameSync(temporary, path);
    syncDir(this.#sessionDir(id));
    state.sinceCheckpoint = 0;
  }

  /** A session's state, rebuilt from its checkpoint and journal the first time it is needed. */
  #state(id: string): SessionState | null {
    const cached = this.#states.get(id);
    if (cached !== undefined) return cached;
    const dir = this.#sessionDir(id);
    if (!existsSync(join(dir, 'journal.jsonl'))) return null;
    const state = this.#rebuild(id, dir);
    this.#states.set(id, state);
    return state;
  }

  #rebuild(id: string, dir: string): SessionState {
    const journal = readFileSync(join(dir, 'journal.jsonl'));
    let state: SessionState | null = null;
    let offset = 0;
    const checkpointPath = join(dir, 'checkpoint.json');
    if (existsSync(checkpointPath)) {
      const checkpoint = parse<Checkpoint>(readFileSync(checkpointPath, 'utf8'));
      if (checkpoint.offset <= journal.length) {
        state = {
          record: checkpoint.record,
          running: new Map(checkpoint.running.map((effect) => [effect.request.key, effect])),
          finished: new Set(checkpoint.finished),
          requests: new Map(checkpoint.requests.map((request) => [request.id, request])),
          inbox: new Map(checkpoint.inbox.map((item) => [item.ord, item])),
          nextOrd: checkpoint.nextOrd,
          lines: checkpoint.lines,
          entryLines: checkpoint.entryLines ?? [],
          nextEntry: checkpoint.nextEntry ?? null,
          size: checkpoint.offset,
          sinceCheckpoint: 0,
        };
        offset = checkpoint.offset;
      }
    }
    while (offset < journal.length) {
      const end = journal.indexOf(0x0a, offset);
      const record = end === -1 ? null : decode(journal.subarray(offset, end).toString('utf8'));
      if (record === null) {
        if (end !== -1 && end + 1 < journal.length) {
          throw new StoreError('invalid', `the journal of ${id} is damaged at byte ${offset}`);
        }
        // A last line half written by a crash: cut off.
        const fd = this.#journal(id);
        ftruncateSync(fd, offset);
        fsyncSync(fd);
        break;
      }
      if (state === null) {
        if (record.t !== 'create')
          throw new StoreError('invalid', `the journal of ${id} does not start with its creation`);
        state = emptyState(record.session);
      }
      apply(state, record, offset, end + 1 - offset);
      state.sinceCheckpoint += 1;
      offset = end + 1;
    }
    if (state === null) throw new StoreError('invalid', `the journal of ${id} is empty`);
    return state;
  }

  /** Every session's state, loading the ones not yet loaded. */
  #all(): SessionState[] {
    if (!this.#scanned) {
      for (const name of names(join(this.#dir, 'sessions'))) this.#state(unsafe(name));
      this.#scanned = true;
    }
    return [...this.#states.values()];
  }

  #require(id: string): SessionState {
    const state = this.#state(id);
    if (state === null) throw new StoreError('no_session', `no session ${id}`);
    return state;
  }

  #journal(id: string): number {
    const open = this.#journals.get(id);
    if (open !== undefined) return open;
    const fd = openSync(join(this.#sessionDir(id), 'journal.jsonl'), 'r+');
    this.#journals.set(id, fd);
    return fd;
  }

  #closeJournal(id: string): void {
    const fd = this.#journals.get(id);
    if (fd !== undefined) closeSync(fd);
    this.#journals.delete(id);
  }

  // ---- files ----------------------------------------------------------------

  #lock(): void {
    const path = join(this.#dir, 'lock');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        writeFileSync(path, String(process.pid), { flag: 'wx' });
        return;
      } catch (error) {
        if (!isCode(error, 'EEXIST')) throw error;
        const pid = readPid(path);
        if (pid !== null && alive(pid))
          throw new StoreError('locked', 'another runner has the store open');
        // Left by a runner that is gone.
        rmSync(path, { force: true });
      }
    }
    throw new StoreError('locked', 'another runner has the store open');
  }

  #readBundle(ref: AgentRef): Bundle | null {
    const dir = this.#bundleDir(ref);
    if (!existsSync(join(dir, 'bundle.json'))) return null;
    const meta = parse<{ hash: string; kinds: Record<string, KindInfo> }>(
      readFileSync(join(dir, 'bundle.json'), 'utf8'),
    );
    return {
      name: ref.name,
      version: ref.version,
      hash: meta.hash,
      agent: readFileSync(join(dir, 'agent.js'), 'utf8'),
      handlers: readFileSync(join(dir, 'handlers.js'), 'utf8'),
      kinds: meta.kinds,
    };
  }

  #bundleDir(ref: AgentRef): string {
    return join(this.#dir, 'agents', safe(ref.name), safe(ref.version));
  }

  #sessionDir(id: string): string {
    return join(this.#dir, 'sessions', safe(id));
  }

  #run<T>(body: () => T): Promise<T> {
    if (!this.#open) return Promise.reject(new StoreError('invalid', 'the store is closed'));
    try {
      return Promise.resolve(body());
    } catch (error) {
      return Promise.reject(
        error instanceof StoreError ? error : new StoreError('invalid', String(error)),
      );
    }
  }
}

// ---- records --------------------------------------------------------------

function emptyState(record: SessionRecord): SessionState {
  return {
    record: { ...record },
    running: new Map(),
    finished: new Set(),
    requests: new Map(),
    inbox: new Map(),
    nextOrd: 1,
    lines: [],
    entryLines: [],
    nextEntry: null,
    size: 0,
    sinceCheckpoint: 0,
  };
}

/** Applies one journal record to a session's state. */
function apply(state: SessionState, record: JournalRecord, offset: number, length: number): void {
  state.size = offset + length;
  switch (record.t) {
    case 'create':
      state.record = {
        ...record.session,
        nextSeq: record.session.nextSeq + record.append.length,
      };
      index(state, record.append, offset, length);
      indexEntries(state, record.journal ?? [], offset, length);
      for (const effect of record.started) state.running.set(effect.request.key, effect);
      for (const key of record.finished ?? []) state.finished.add(key);
      for (const request of record.requests ?? []) state.requests.set(request.id, request);
      if (record.request !== undefined) state.requests.set(record.request.id, record.request);
      return;
    case 'commit': {
      const { step } = record;
      state.record = {
        ...state.record,
        snapshot: step.snapshot,
        nextSeq: step.expectedSeq + step.append.length,
        ...(step.config === undefined ? {} : { config: step.config }),
        ...(step.agent === undefined ? {} : { agent: step.agent }),
        ...(step.clearFault === true ? { fault: null } : {}),
      };
      index(state, step.append, offset, length);
      for (const key of step.finished) {
        state.running.delete(key);
        state.finished.add(key);
      }
      for (const key of step.aborted) {
        const effect = state.running.get(key);
        if (effect !== undefined)
          state.running.set(key, { ...effect, request: { ...effect.request, abort: true } });
      }
      for (const effect of step.started) state.running.set(effect.request.key, effect);
      if (step.consumed !== undefined) state.inbox.delete(step.consumed);
      if (step.request !== undefined) state.requests.set(step.request.id, step.request);
      if (step.journal !== undefined) indexEntries(state, [step.journal], offset, length);
      return;
    }
    case 'result':
      state.inbox.set(record.ord, { ord: record.ord, key: record.key, outcome: record.outcome });
      state.nextOrd = Math.max(state.nextOrd, record.ord + 1);
      return;
    case 'drop':
      state.inbox.delete(record.ord);
      return;
    case 'attempt': {
      const effect = state.running.get(record.key);
      if (effect !== undefined)
        state.running.set(record.key, { ...effect, attempt: record.attempt });
      return;
    }
    case 'fault':
      state.record = { ...state.record, fault: record.fault };
      return;
    case 'request':
      state.requests.set(record.request.id, record.request);
      return;
    case 'entry':
      indexEntries(state, [record.entry], offset, length);
      if (record.request !== undefined) state.requests.set(record.request.id, record.request);
      if (record.fault !== undefined) state.record = { ...state.record, fault: record.fault };
      return;
  }
}

function indexEntries(
  state: SessionState,
  entries: readonly JournalEntry[],
  offset: number,
  length: number,
): void {
  const first = entries[0];
  const last = entries.at(-1);
  if (first === undefined || last === undefined) return;
  state.entryLines.push({ offset, length, firstN: first.n, count: entries.length });
  state.nextEntry = last.n + 1;
}

function journalEntriesOf(record: JournalRecord): JournalEntry[] {
  if (record.t === 'create') return record.journal ?? [];
  if (record.t === 'commit') return record.step.journal === undefined ? [] : [record.step.journal];
  if (record.t === 'entry') return [record.entry];
  return [];
}

function index(
  state: SessionState,
  append: readonly LogEntry[],
  offset: number,
  length: number,
): void {
  const first = append[0];
  if (first !== undefined)
    state.lines.push({ offset, length, firstSeq: first.seq, count: append.length });
}

function entriesOf(record: JournalRecord): LogEntry[] {
  if (record.t === 'create') return record.append;
  if (record.t === 'commit') return record.step.append;
  return [];
}

/** A journal line: a checksum of the record, a space, the record, a newline. */
function encode(record: JournalRecord): string {
  const json = JSON.stringify(record);
  return `${checksum(json)} ${json}\n`;
}

/** The record on a line, or null if the line is not one whole, intact record. */
function decode(line: string): JournalRecord | null {
  const space = line.indexOf(' ');
  if (space === -1) return null;
  const json = line.slice(space + 1);
  if (checksum(json) !== line.slice(0, space)) return null;
  try {
    return parse<JournalRecord>(json);
  } catch {
    return null;
  }
}

function readRecord(fd: number, line: { offset: number; length: number }): JournalRecord {
  const buffer = Buffer.alloc(line.length);
  readSync(fd, buffer, 0, line.length, line.offset);
  const record = decode(buffer.toString('utf8').replace(/\n$/, ''));
  if (record === null)
    throw new StoreError('invalid', `a journal line at byte ${line.offset} is damaged`);
  return record;
}

function checksum(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * Reads back Json this store wrote: every file parsed here holds only values
 * the store serialised from the type it is read as, behind a checksum or a
 * rename that makes it whole.
 */
// The type parameter names what the file holds; nothing checks it.
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
function parse<T>(json: string): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return JSON.parse(json) as T;
}

function checkDense(entries: readonly LogEntry[], from: number): void {
  for (const [position, entry] of entries.entries()) {
    if (entry.seq !== from + position) {
      throw new StoreError(
        'invalid',
        `log entry ${position} has seq ${entry.seq}, not ${from + position}`,
      );
    }
  }
}

// ---- the filesystem -------------------------------------------------------

/** Writes a file and syncs it to disk. */
function writeDurably(path: string, text: string): void {
  const fd = openSync(path, 'w');
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Syncs a folder, so a rename or new file in it survives a crash. */
function syncDir(dir: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    // Not every platform syncs folders; the rename is still atomic.
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** The names in a folder, without temporary ones. */
function names(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => !name.startsWith('.tmp-'));
}

/** A name made safe as one path segment. */
function safe(name: string): string {
  return encodeURIComponent(name).replace(/^\./, '%2E');
}

function unsafe(segment: string): string {
  return decodeURIComponent(segment);
}

function readPid(path: string): number | null {
  try {
    const pid = Number(readFileSync(path, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isCode(error, 'EPERM');
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === code;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
