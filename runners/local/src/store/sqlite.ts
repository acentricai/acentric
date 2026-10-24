// A store in one SQLite file, through Node's built-in node:sqlite.
//
// Every commit is one transaction, written with synchronous=FULL, so it is
// on disk when the commit resolves. The database is opened in exclusive
// locking mode and written once at open, which takes the lock for as long
// as the store is open: a second runner opening the same file fails with
// 'locked'.
//
// node:sqlite is synchronous. The methods are async to satisfy the Store
// type, which other backends need; here they finish before they return.
//
// Schema 3 added the journal table. A store with schema 2 is moved to 3 when
// opened; its sessions keep no journal, since theirs would not start with
// their creation.

import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';

import type { JournalEntry, Json, JsonObject, LogEntry, Outcome } from '@acentric/types';

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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bundles (
  name TEXT NOT NULL, version TEXT NOT NULL, hash TEXT NOT NULL,
  agent TEXT NOT NULL, handlers TEXT NOT NULL, kinds TEXT NOT NULL,
  PRIMARY KEY (name, version)
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, agent_name TEXT NOT NULL, agent_version TEXT NOT NULL,
  config TEXT NOT NULL, snapshot TEXT NOT NULL, next_seq INTEGER NOT NULL,
  fault TEXT, create_hash TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS log (
  session TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL,
  kind TEXT NOT NULL, body TEXT NOT NULL,
  PRIMARY KEY (session, seq)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS effects (
  session TEXT NOT NULL, key TEXT NOT NULL, status TEXT NOT NULL,
  request TEXT, mode TEXT, attempt INTEGER,
  UNIQUE (session, key)
);
CREATE INDEX IF NOT EXISTS effects_running ON effects (session) WHERE status = 'running';
CREATE TABLE IF NOT EXISTS inbox (
  ord INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL,
  key TEXT NOT NULL, outcome TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS inbox_session ON inbox (session, ord);
CREATE TABLE IF NOT EXISTS requests (
  session TEXT NOT NULL, id TEXT NOT NULL, hash TEXT NOT NULL, answer TEXT NOT NULL,
  PRIMARY KEY (session, id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS journal (
  session TEXT NOT NULL, n INTEGER NOT NULL, entry TEXT NOT NULL,
  PRIMARY KEY (session, n)
) WITHOUT ROWID;
`;

const SCHEMA_VERSION = '3';

/** Opens, or creates, the store in the SQLite file at `path`. */
export function openSqliteStore(path: string): Promise<Store> {
  try {
    return Promise.resolve(new SqliteStore(path));
  } catch (error) {
    return Promise.reject(error instanceof StoreError ? error : toStoreError(error));
  }
}

type Row = Record<string, SQLOutputValue>;

class SqliteStore implements Store {
  readonly #db: DatabaseSync;
  #open = true;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec('PRAGMA locking_mode = EXCLUSIVE');
      this.#db.exec('PRAGMA journal_mode = WAL');
      this.#db.exec('PRAGMA synchronous = FULL');
      this.#transaction(() => {
        this.#db.exec(SCHEMA);
        const version = this.#db.prepare('SELECT value FROM meta WHERE key = ?').get('schema');
        if (version === undefined) {
          this.#db
            .prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
            .run('schema', SCHEMA_VERSION);
        } else if (text(version, 'value') === '2') {
          // Schema 3 only adds the journal table, created above.
          this.#db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(SCHEMA_VERSION, 'schema');
        } else if (text(version, 'value') !== SCHEMA_VERSION) {
          throw new StoreError(
            'invalid',
            `the store has schema ${text(version, 'value')}, not ${SCHEMA_VERSION}`,
          );
        }
      });
    } catch (error) {
      this.#db.close();
      throw error instanceof StoreError ? error : toStoreError(error);
    }
  }

  // ---- bundles --------------------------------------------------------------

  putBundle(bundle: Bundle): Promise<'stored' | 'exists'> {
    return this.#run(() => {
      const existing = this.#db
        .prepare('SELECT hash FROM bundles WHERE name = ? AND version = ?')
        .get(bundle.name, bundle.version);
      if (existing !== undefined) {
        if (text(existing, 'hash') === bundle.hash) return 'exists';
        throw new StoreError(
          'bundle_conflict',
          `different code is already deployed as ${bundle.name}@${bundle.version}`,
        );
      }
      this.#db
        .prepare(
          'INSERT INTO bundles (name, version, hash, agent, handlers, kinds) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          bundle.name,
          bundle.version,
          bundle.hash,
          bundle.agent,
          bundle.handlers,
          JSON.stringify(bundle.kinds),
        );
      return 'stored';
    });
  }

  getBundle(ref: AgentRef): Promise<Bundle | null> {
    return this.#run(() => {
      const row = this.#db
        .prepare('SELECT * FROM bundles WHERE name = ? AND version = ?')
        .get(ref.name, ref.version);
      if (row === undefined) return null;
      return {
        name: text(row, 'name'),
        version: text(row, 'version'),
        hash: text(row, 'hash'),
        agent: text(row, 'agent'),
        handlers: text(row, 'handlers'),
        kinds: stored<Record<string, KindInfo>>(text(row, 'kinds')),
      };
    });
  }

  deleteBundle(ref: AgentRef): Promise<void> {
    return this.#run(() => {
      this.#db
        .prepare('DELETE FROM bundles WHERE name = ? AND version = ?')
        .run(ref.name, ref.version);
    });
  }

  listBundles(): Promise<(AgentRef & { hash: string; sessions: number })[]> {
    return this.#run(() =>
      this.#db
        .prepare(
          `SELECT b.name, b.version, b.hash,
             (SELECT count(*) FROM sessions i WHERE i.agent_name = b.name AND i.agent_version = b.version) AS sessions
           FROM bundles b ORDER BY b.name, b.version`,
        )
        .all()
        .map((row) => ({
          name: text(row, 'name'),
          version: text(row, 'version'),
          hash: text(row, 'hash'),
          sessions: int(row, 'sessions'),
        })),
    );
  }

  // ---- sessions ------------------------------------------------------------

  create(session: SessionRecord, init: SessionStart): Promise<void> {
    return this.#run(() =>
      this.#transaction(() => {
        if (this.#db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(session.id) !== undefined) {
          throw new StoreError('session_exists', `session ${session.id} already exists`);
        }
        const nextSeq = session.nextSeq + init.append.length;
        checkDense(init.append, session.nextSeq);
        this.#db
          .prepare(
            `INSERT INTO sessions (id, agent_name, agent_version, config, snapshot, next_seq, fault, create_hash, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            session.id,
            session.agent.name,
            session.agent.version,
            JSON.stringify(session.config),
            JSON.stringify(session.snapshot),
            nextSeq,
            session.fault,
            session.createHash,
            session.createdAt,
          );
        this.#append(session.id, init.append);
        this.#start(session.id, init.started);
        const finished = this.#db.prepare(
          "INSERT INTO effects (session, key, status) VALUES (?, ?, 'finished')",
        );
        for (const key of init.finished ?? []) finished.run(session.id, key);
        for (const request of init.requests ?? []) this.#putRequest(session.id, request);
        if (init.request !== undefined) this.#putRequest(session.id, init.request);
        for (const entry of init.journal) this.#putEntry(session.id, entry);
      }),
    );
  }

  load(id: string): Promise<LoadedSession | null> {
    return this.#run(() => {
      const row = this.#db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
      if (row === undefined) return null;
      const running = this.#db
        .prepare(
          "SELECT request, mode, attempt FROM effects WHERE session = ? AND status = 'running' ORDER BY rowid",
        )
        .all(id)
        .map((effect) => ({
          request: stored<StoredEffect['request']>(text(effect, 'request')),
          mode: text(effect, 'mode') === 'once' ? ('once' as const) : ('reissue' as const),
          attempt: int(effect, 'attempt'),
        }));
      const newest = this.#db.prepare('SELECT max(n) AS n FROM journal WHERE session = ?').get(id);
      const n = newest?.['n'];
      return { ...record(row), running, nextEntry: typeof n === 'number' ? n + 1 : null };
    });
  }

  list(filter: SessionFilter = {}): Promise<SessionSummary[]> {
    return this.#run(() => {
      const where: string[] = [];
      const params: SQLInputValue[] = [];
      if (filter.agent !== undefined) {
        where.push('agent_name = ?');
        params.push(filter.agent);
      }
      if (filter.faulted !== undefined)
        where.push(filter.faulted ? 'fault IS NOT NULL' : 'fault IS NULL');
      if (filter.after !== undefined) {
        where.push('id > ?');
        params.push(filter.after);
      }
      params.push(filter.limit ?? -1);
      return this.#db
        .prepare(
          `SELECT id, agent_name, agent_version, next_seq, fault, created_at,
             (SELECT count(*) FROM effects e WHERE e.session = sessions.id AND e.status = 'running') AS running
           FROM sessions ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
           ORDER BY id LIMIT ?`,
        )
        .all(...params)
        .map((row) => ({
          id: text(row, 'id'),
          agent: { name: text(row, 'agent_name'), version: text(row, 'agent_version') },
          nextSeq: int(row, 'next_seq'),
          fault: optionalText(row, 'fault'),
          running: int(row, 'running'),
          createdAt: int(row, 'created_at'),
        }));
    });
  }

  pending(): Promise<string[]> {
    return this.#run(() =>
      this.#db
        .prepare(
          `SELECT DISTINCT session FROM effects WHERE status = 'running'
           UNION SELECT DISTINCT session FROM inbox ORDER BY session`,
        )
        .all()
        .map((row) => text(row, 'session')),
    );
  }

  // ---- steps ----------------------------------------------------------------

  commit(id: string, step: StepCommit): Promise<void> {
    return this.#run(() =>
      this.#transaction(() => {
        checkDense(step.append, step.expectedSeq);
        const sets = ['snapshot = ?', 'next_seq = ?'];
        const params: SQLInputValue[] = [
          JSON.stringify(step.snapshot),
          step.expectedSeq + step.append.length,
        ];
        if (step.config !== undefined) {
          sets.push('config = ?');
          params.push(JSON.stringify(step.config));
        }
        if (step.agent !== undefined) {
          sets.push('agent_name = ?', 'agent_version = ?');
          params.push(step.agent.name, step.agent.version);
        }
        if (step.clearFault === true) sets.push('fault = NULL');
        const updated = this.#db
          .prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ? AND next_seq = ?`)
          .run(...params, id, step.expectedSeq);
        if (Number(updated.changes) !== 1) {
          if (this.#db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(id) === undefined) {
            throw new StoreError('no_session', `no session ${id}`);
          }
          throw new StoreError(
            'stale_commit',
            `session ${id} has moved past seq ${step.expectedSeq}`,
          );
        }
        this.#append(id, step.append);
        this.#finish(id, step.finished);
        const abort = this.#db.prepare(
          "UPDATE effects SET request = json_set(request, '$.abort', json('true')) WHERE session = ? AND key = ? AND status = 'running'",
        );
        for (const key of step.aborted) abort.run(id, key);
        this.#start(id, step.started);
        if (step.consumed !== undefined) {
          const removed = this.#db
            .prepare('DELETE FROM inbox WHERE ord = ? AND session = ?')
            .run(step.consumed, id);
          if (Number(removed.changes) !== 1) {
            throw new StoreError('invalid', `inbox item ${step.consumed} of ${id} does not exist`);
          }
        }
        if (step.request !== undefined) this.#putRequest(id, step.request);
        if (step.journal !== undefined) this.#putEntry(id, step.journal);
      }),
    );
  }

  record(
    id: string,
    entry: JournalEntry,
    alongside: { request?: RequestRecord; fault?: string },
  ): Promise<void> {
    return this.#run(() =>
      this.#transaction(() => {
        if (alongside.request !== undefined) this.#putRequest(id, alongside.request);
        if (alongside.fault !== undefined) {
          this.#db.prepare('UPDATE sessions SET fault = ? WHERE id = ?').run(alongside.fault, id);
        }
        this.#putEntry(id, entry);
      }),
    );
  }

  readJournal(id: string, range: JournalRange = {}): Promise<JournalEntry[]> {
    return this.#run(() =>
      this.#db
        .prepare('SELECT entry FROM journal WHERE session = ? AND n > ? ORDER BY n LIMIT ?')
        .all(id, range.after ?? 0, range.limit ?? -1)
        .map((row) => stored<JournalEntry>(text(row, 'entry'))),
    );
  }

  readLog(id: string, range: LogRange = {}): Promise<LogEntry[]> {
    return this.#run(() => {
      const where = ['session = ?'];
      const params: SQLInputValue[] = [id];
      if (range.after !== undefined) {
        where.push('seq > ?');
        params.push(range.after);
      }
      if (range.before !== undefined) {
        where.push('seq < ?');
        params.push(range.before);
      }
      if (range.kinds !== undefined) {
        if (range.kinds.length === 0) return [];
        where.push(`kind IN (${range.kinds.map(() => '?').join(', ')})`);
        params.push(...range.kinds);
      }
      params.push(range.limit ?? -1);
      return this.#db
        .prepare(
          `SELECT seq, at, kind, body FROM log WHERE ${where.join(' AND ')} ORDER BY seq LIMIT ?`,
        )
        .all(...params)
        .map((row) => ({
          seq: int(row, 'seq'),
          at: int(row, 'at'),
          kind: text(row, 'kind'),
          body: stored<Json>(text(row, 'body')),
        }));
    });
  }

  findFinished(id: string, keys: readonly string[]): Promise<Set<string>> {
    return this.#run(() => {
      const found = new Set<string>();
      for (let start = 0; start < keys.length; start += 500) {
        const chunk = keys.slice(start, start + 500);
        const rows = this.#db
          .prepare(
            `SELECT key FROM effects WHERE session = ? AND status = 'finished' AND key IN (${chunk.map(() => '?').join(', ')})`,
          )
          .all(id, ...chunk);
        for (const row of rows) found.add(text(row, 'key'));
      }
      return found;
    });
  }

  // ---- requests -------------------------------------------------------------

  findRequest(id: string, requestId: string): Promise<RequestRecord | null> {
    return this.#run(() => {
      const row = this.#db
        .prepare('SELECT hash, answer FROM requests WHERE session = ? AND id = ?')
        .get(id, requestId);
      return row === undefined
        ? null
        : { id: requestId, hash: text(row, 'hash'), answer: stored<Json>(text(row, 'answer')) };
    });
  }

  putRequest(id: string, request: RequestRecord): Promise<void> {
    return this.#run(() => this.#putRequest(id, request));
  }

  // ---- effects between steps ------------------------------------------------

  putResult(id: string, key: string, outcome: Outcome): Promise<number> {
    return this.#run(() => {
      const inserted = this.#db
        .prepare('INSERT INTO inbox (session, key, outcome) VALUES (?, ?, ?)')
        .run(id, key, JSON.stringify(outcome));
      return Number(inserted.lastInsertRowid);
    });
  }

  inbox(id: string): Promise<InboxItem[]> {
    return this.#run(() =>
      this.#db
        .prepare('SELECT ord, key, outcome FROM inbox WHERE session = ? ORDER BY ord')
        .all(id)
        .map((row) => ({
          ord: int(row, 'ord'),
          key: text(row, 'key'),
          outcome: stored<Outcome>(text(row, 'outcome')),
        })),
    );
  }

  dropResult(id: string, ord: number): Promise<void> {
    return this.#run(() => {
      this.#db.prepare('DELETE FROM inbox WHERE ord = ? AND session = ?').run(ord, id);
    });
  }

  recordAttempt(id: string, key: string, attempt: number): Promise<void> {
    return this.#run(() => {
      this.#db
        .prepare(
          "UPDATE effects SET attempt = ? WHERE session = ? AND key = ? AND status = 'running'",
        )
        .run(attempt, id, key);
    });
  }

  setFault(id: string, fault: string): Promise<void> {
    return this.#run(() => {
      this.#db.prepare('UPDATE sessions SET fault = ? WHERE id = ?').run(fault, id);
    });
  }

  delete(id: string): Promise<void> {
    return this.#run(() =>
      this.#transaction(() => {
        for (const table of ['log', 'effects', 'inbox', 'requests', 'journal']) {
          this.#db.prepare(`DELETE FROM ${table} WHERE session = ?`).run(id);
        }
        this.#db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      }),
    );
  }

  close(): Promise<void> {
    if (this.#open) {
      this.#open = false;
      this.#db.close();
    }
    return Promise.resolve();
  }

  // ---- helpers --------------------------------------------------------------

  #append(id: string, entries: readonly LogEntry[]): void {
    const insert = this.#db.prepare(
      'INSERT INTO log (session, seq, at, kind, body) VALUES (?, ?, ?, ?, ?)',
    );
    for (const entry of entries)
      insert.run(id, entry.seq, entry.at, entry.kind, JSON.stringify(entry.body));
  }

  #start(id: string, effects: readonly StoredEffect[]): void {
    const insert = this.#db.prepare(
      "INSERT INTO effects (session, key, status, request, mode, attempt) VALUES (?, ?, 'running', ?, ?, ?)",
    );
    for (const effect of effects) {
      insert.run(
        id,
        effect.request.key,
        JSON.stringify(effect.request),
        effect.mode,
        effect.attempt,
      );
    }
  }

  #finish(id: string, keys: readonly string[]): void {
    const update = this.#db.prepare(
      "UPDATE effects SET status = 'finished', request = NULL, mode = NULL, attempt = NULL WHERE session = ? AND key = ?",
    );
    for (const key of keys) {
      if (Number(update.run(id, key).changes) !== 1) {
        throw new StoreError('invalid', `effect ${key} of ${id} is not running`);
      }
    }
  }

  #putEntry(id: string, entry: JournalEntry): void {
    this.#db
      .prepare('INSERT INTO journal (session, n, entry) VALUES (?, ?, ?)')
      .run(id, entry.n, JSON.stringify(entry));
  }

  #putRequest(id: string, request: RequestRecord): void {
    this.#db
      .prepare('INSERT INTO requests (session, id, hash, answer) VALUES (?, ?, ?, ?)')
      .run(id, request.id, request.hash, JSON.stringify(request.answer));
  }

  #transaction<T>(body: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = body();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Runs a synchronous body as a promise, with SQLite's errors as StoreErrors. */
  #run<T>(body: () => T): Promise<T> {
    if (!this.#open) return Promise.reject(new StoreError('invalid', 'the store is closed'));
    try {
      return Promise.resolve(body());
    } catch (error) {
      return Promise.reject(error instanceof StoreError ? error : toStoreError(error));
    }
  }
}

function checkDense(entries: readonly LogEntry[], from: number): void {
  for (const [index, entry] of entries.entries()) {
    if (entry.seq !== from + index) {
      throw new StoreError(
        'invalid',
        `log entry ${index} has seq ${entry.seq}, not ${from + index}`,
      );
    }
  }
}

function record(row: Row): SessionRecord {
  return {
    id: text(row, 'id'),
    agent: { name: text(row, 'agent_name'), version: text(row, 'agent_version') },
    config: stored<JsonObject>(text(row, 'config')),
    snapshot: stored<JsonObject>(text(row, 'snapshot')),
    nextSeq: int(row, 'next_seq'),
    fault: optionalText(row, 'fault'),
    createHash: text(row, 'create_hash'),
    createdAt: int(row, 'created_at'),
  };
}

function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new StoreError('invalid', `column ${column} is not text`);
  return value;
}

function optionalText(row: Row, column: string): string | null {
  const value = row[column];
  return value === null || value === undefined ? null : text(row, column);
}

function int(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new StoreError('invalid', `column ${column} is not a number`);
}

/**
 * Reads back Json this store wrote. Every column parsed here holds only
 * values the store serialised from the type it is read as.
 */
// The type parameter names what the column holds; nothing checks it.
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
function stored<T>(json: string): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return JSON.parse(json) as T;
}

function toStoreError(error: unknown): StoreError {
  const message = error instanceof Error ? error.message : String(error);
  if (/database is locked|SQLITE_BUSY/i.test(message)) {
    return new StoreError('locked', 'another runner has the store open');
  }
  return new StoreError('invalid', message);
}
