// The database's own thread. SQLite answers at once and blocks whoever asks while it does, so
// nothing of the engine asks it directly: the store sends what it wants here, and goes on.
//
// What was asked while the thread was busy is taken together. Every write among it goes into
// one transaction, so the disk is waited for once for all of them, whichever actors they are
// for. Each write is still its own: one that is refused takes no other with it.

import { parentPort, receiveMessageOnPort, workerData } from 'node:worker_threads';

import { Refused, WRITES, open, operations } from './database.ts';
import type { Operation } from './database.ts';
import { migrate } from './migrations.ts';

export type Settings = {
  readonly path: string;
  /** A thread that only reads has a connection that cannot write. */
  readonly readOnly: boolean;
  /** Without it, every write is a transaction of its own: for measuring what the grouping saves. */
  readonly groupCommit: boolean;
};

export type Request = {
  readonly id: number;
  readonly op: Operation | 'stats' | 'close';
  readonly args: readonly unknown[];
};

export type Reply =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | {
      readonly id: number;
      readonly ok: false;
      readonly message: string;
      readonly refused?: {
        readonly kind: Refused['kind'];
        readonly args: readonly (string | number)[];
      };
    };

const port = parentPort;
if (port === null) throw new Error('This file is a thread of the store, and was run as a program');
const settings = workerData as Settings;

const db = open(settings.path, settings.readOnly);
if (!settings.readOnly) migrate(db);
const ops = operations(db) as unknown as { [op: string]: (...args: never[]) => unknown };

/** How many writes were stored, and in how many transactions. */
const stats = { writes: 0, transactions: 0 };

function failed(id: number, error: unknown): Reply {
  if (error instanceof Refused) {
    return {
      id,
      ok: false,
      message: error.message,
      refused: { kind: error.kind, args: error.args },
    };
  }
  return { id, ok: false, message: error instanceof Error ? error.message : String(error) };
}

function answer(request: Request): Reply {
  try {
    if (request.op === 'stats') return { id: request.id, ok: true, value: { ...stats } };
    if (request.op === 'close') {
      db.close();
      return { id: request.id, ok: true, value: undefined };
    }
    const value = (ops[request.op] as (...args: unknown[]) => unknown)(...request.args);
    return { id: request.id, ok: true, value };
  } catch (error) {
    return failed(request.id, error);
  }
}

/** A write inside the transaction that is open: stored, or undone alone when it is refused. */
function write(request: Request): Reply {
  db.exec('SAVEPOINT one');
  const reply = answer(request);
  if (!reply.ok) db.exec('ROLLBACK TO one');
  db.exec('RELEASE one');
  if (reply.ok) stats.writes += 1;
  return reply;
}

function run(batch: readonly Request[]): Reply[] {
  const isWrite = (request: Request) => WRITES.has(request.op as Operation);
  const groups = settings.groupCommit ? [batch] : batch.map((request) => [request]);
  const replies: Reply[] = [];
  for (const group of groups) {
    if (!group.some(isWrite)) {
      replies.push(...group.map(answer));
      continue;
    }
    const mine: Reply[] = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const request of group) mine.push(isWrite(request) ? write(request) : answer(request));
      db.exec('COMMIT');
      stats.transactions += 1;
      replies.push(...mine);
    } catch (error) {
      // Nothing of the group is on the disk: every write in it is told so.
      if (db.isTransaction) db.exec('ROLLBACK');
      replies.push(
        ...group.map((request, index) =>
          isWrite(request) ? failed(request.id, error) : (mine[index] ?? failed(request.id, error)),
        ),
      );
    }
  }
  return replies;
}

port.on('message', (first: Request) => {
  const batch = [first];
  for (;;) {
    const more = receiveMessageOnPort(port);
    if (more === undefined) break;
    batch.push(more.message as Request);
  }
  port.postMessage(run(batch));
});

port.postMessage('ready');
