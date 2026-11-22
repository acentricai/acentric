// What the store does to the database, as plain functions that run to their end at once. They
// are called on the database's own thread (see `worker.ts`), never on the engine's.

import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, StatementSync } from 'node:sqlite';

import type { ActorRecord, Change, Turn } from '@acentric/core';
import type { Actor, ActorId, ConversationEntry, Input, InputId } from '@acentric/protocol';

/** What the store refuses, in a form that crosses to the engine's thread. */
export class Refused extends Error {
  readonly kind: 'StaleEpoch' | 'NameTaken';
  readonly args: readonly (string | number)[];
  constructor(kind: Refused['kind'], args: readonly (string | number)[]) {
    super(kind);
    this.kind = kind;
    this.args = args;
  }
}

type ActorRow = {
  id: string;
  agent_id: string;
  deployment_id: string;
  deployment_version: number;
  pinned: number;
  behind: string | null;
  name: string | null;
  external_id: string | null;
  model: string;
  reasoning: string;
  configuration: string | null;
  status: string;
  last_turn: string | null;
  turn: string;
  epoch: number;
  next_seq: number;
  created_at: number;
  archived_at: number | null;
  pending: number;
};

type InputRow = {
  id: string;
  actor_id: string;
  type: string;
  external_id: string | null;
  message: string;
  received_at: number;
  delivered_at: number | null;
};

const ACTOR = `SELECT actors.*,
  (SELECT COUNT(*) FROM inputs WHERE actor_id = actors.id AND delivered_at IS NULL) AS pending
  FROM actors`;

function recordOf(row: ActorRow): ActorRecord {
  return {
    actor: {
      id: row.id,
      name: row.name,
      externalId: row.external_id,
      agent: row.agent_id,
      deployment: { id: row.deployment_id, version: row.deployment_version },
      pinned: row.pinned === 1,
      behind: row.behind === null ? null : JSON.parse(row.behind),
      modelId: row.model,
      reasoning: row.reasoning,
      configuration: row.configuration === null ? null : JSON.parse(row.configuration),
      status: row.status,
      lastTurn: row.last_turn === null ? null : JSON.parse(row.last_turn),
      pendingInputs: row.pending,
      createdAt: row.created_at,
      archivedAt: row.archived_at,
    } as Actor,
    turn: JSON.parse(row.turn) as Turn,
    epoch: row.epoch,
    nextSeq: row.next_seq,
  };
}

function inputOf(row: InputRow): Input {
  return {
    id: row.id,
    actor: row.actor_id,
    type: row.type,
    externalId: row.external_id,
    message: JSON.parse(row.message),
    receivedAt: row.received_at,
    deliveredAt: row.delivered_at,
  } as Input;
}

/** The store's operations on one database. Those in `WRITES` change it. */
export type Operations = ReturnType<typeof operations>;
export type Operation = keyof Operations;

export const WRITES: ReadonlySet<Operation> = new Set(['createActor', 'commit', 'addInput']);

export function open(path: string, readOnly: boolean, fullFsync = false): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly });
  if (!readOnly) {
    // A commit is on the disk before anyone is told of it. Readers do not wait for a writer.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    // On macOS a sync does not reach the disk itself unless it is asked to, at a cost. It makes
    // no difference elsewhere, where a sync always does.
    if (fullFsync) db.exec('PRAGMA fullfsync = ON');
  }
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

export function operations(db: DatabaseSync) {
  const statements = new Map<string, StatementSync>();
  const statement = (sql: string): StatementSync => {
    let prepared = statements.get(sql);
    if (prepared === undefined) {
      prepared = db.prepare(sql);
      statements.set(sql, prepared);
    }
    return prepared;
  };
  const run = (sql: string, ...values: SQLInputValue[]) =>
    Number(statement(sql).run(...values).changes);
  const get = <T>(sql: string, ...values: SQLInputValue[]) =>
    statement(sql).get(...values) as T | undefined;
  const all = <T>(sql: string, ...values: SQLInputValue[]) => statement(sql).all(...values) as T[];

  return {
    createActor(actor: Actor): { record: ActorRecord; created: boolean } {
      if (actor.externalId !== null) {
        const there = get<ActorRow>(
          `${ACTOR} WHERE agent_id = ? AND external_id = ?`,
          actor.agent,
          actor.externalId,
        );
        if (there !== undefined) return { record: recordOf(there), created: false };
      }
      if (
        actor.name !== null &&
        get('SELECT 1 FROM actors WHERE agent_id = ? AND name = ?', actor.agent, actor.name) !==
          undefined
      ) {
        throw new Refused('NameTaken', [actor.name]);
      }
      const turn: Turn = { phase: 'idle' };
      run(
        `INSERT INTO actors (id, agent_id, deployment_id, deployment_version, pinned, behind, name, external_id,
           model, reasoning, configuration, status, last_turn, turn, owed, epoch, next_seq,
           created_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 1, ?, ?)`,
        actor.id,
        actor.agent,
        actor.deployment.id,
        actor.deployment.version,
        actor.pinned ? 1 : 0,
        actor.behind === null ? null : JSON.stringify(actor.behind),
        actor.name,
        actor.externalId,
        actor.modelId,
        actor.reasoning,
        actor.configuration === null ? null : JSON.stringify(actor.configuration),
        actor.status,
        actor.lastTurn === null ? null : JSON.stringify(actor.lastTurn),
        JSON.stringify(turn),
        actor.createdAt,
        actor.archivedAt,
      );
      return {
        record: { actor: { ...actor, pendingInputs: 0 }, turn, epoch: 0, nextSeq: 1 },
        created: true,
      };
    },

    loadActor(id: ActorId): ActorRecord | undefined {
      const row = get<ActorRow>(`${ACTOR} WHERE id = ?`, id);
      return row === undefined ? undefined : recordOf(row);
    },

    commit(id: ActorId, epoch: number, change: Change): void {
      const changed = run(
        `UPDATE actors SET status = ?, last_turn = ?, archived_at = ?, turn = ?, owed = ?,
           epoch = epoch + 1, next_seq = next_seq + ?
         WHERE id = ? AND epoch = ?`,
        change.status,
        change.lastTurn === null ? null : JSON.stringify(change.lastTurn),
        change.archivedAt,
        JSON.stringify(change.turn),
        change.turn.phase === 'idle' ? 0 : 1,
        change.append.length,
        id,
        epoch,
      );
      if (changed === 0) {
        const row = get<{ epoch: number }>('SELECT epoch FROM actors WHERE id = ?', id);
        if (row === undefined) throw new Error(`There is no actor ${id}`);
        throw new Refused('StaleEpoch', [id, epoch, row.epoch]);
      }
      for (const entry of change.append) {
        run(
          'INSERT INTO messages (actor_id, seq, entry) VALUES (?, ?, ?)',
          id,
          entry.seq,
          JSON.stringify(entry),
        );
      }
      if (change.leaveOutFrom !== null) {
        run(
          `UPDATE messages SET entry = json_set(entry, '$.leftOut', json('true'))
           WHERE actor_id = ? AND seq >= ?`,
          id,
          change.leaveOutFrom,
        );
      }
      for (const input of change.deliver) {
        run(
          'UPDATE inputs SET delivered_at = ? WHERE id = ? AND actor_id = ?',
          change.at,
          input,
          id,
        );
      }
    },

    addInput(input: Input): 'accepted' | 'duplicate' {
      const inserted = run(
        `INSERT INTO inputs (id, actor_id, type, external_id, message, received_at, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (actor_id, external_id) WHERE external_id IS NOT NULL DO NOTHING`,
        input.id,
        input.actor,
        input.type,
        input.externalId,
        JSON.stringify(input.message),
        input.receivedAt,
        input.deliveredAt,
      );
      return inserted === 0 ? 'duplicate' : 'accepted';
    },

    findInput(actor: ActorId, externalId: string): InputId | undefined {
      const row = get<{ id: InputId }>(
        'SELECT id FROM inputs WHERE actor_id = ? AND external_id = ?',
        actor,
        externalId,
      );
      return row?.id;
    },

    pendingInputs(actor: ActorId): Input[] {
      return all<InputRow>(
        'SELECT * FROM inputs WHERE actor_id = ? AND delivered_at IS NULL ORDER BY rowid',
        actor,
      ).map(inputOf);
    },

    conversation(
      actor: ActorId,
      part: { after?: number; limit?: number } = {},
    ): ConversationEntry[] {
      return all<{ entry: string }>(
        'SELECT entry FROM messages WHERE actor_id = ? AND seq > ? ORDER BY seq LIMIT ?',
        actor,
        part.after ?? 0,
        // SQLite reads a limit below zero as none.
        part.limit ?? -1,
      ).map((row) => JSON.parse(row.entry) as ConversationEntry);
    },

    unfinished(): ActorId[] {
      return all<{ id: ActorId }>(
        `SELECT id FROM actors WHERE owed = 1
         UNION SELECT actor_id FROM inputs WHERE delivered_at IS NULL`,
      ).map((row) => row.id);
    },
  };
}
