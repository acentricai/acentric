// One server, or one restore, on a folder of data at a time. The lock is SQLite's own on a file
// of its own beside the database: held as long as the process that took it has it open, and let
// go by the system when that process ends, however it ends. So a server that died leaves no lock
// behind, and two servers given the same volume by mistake do not both run on it.

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

/** The file the lock is held on, in the folder of data. */
export const LOCK_FILE = 'engine.lock';

/** A server, or a restore, has the folder already. */
export class DataInUse extends Error {
  override readonly name = 'DataInUse';
  constructor(data: string) {
    super(
      `A server is running on ${data}, or a restore is: one at a time has its data. Stop it first.`,
    );
  }
}

/** The lock on a folder of data, until `release`. */
export type DataLock = { release(): void };

/** Takes the lock on `data`, or throws DataInUse when another process has it. */
export function lockData(data: string): DataLock {
  const db = new DatabaseSync(join(data, LOCK_FILE));
  try {
    db.exec('PRAGMA busy_timeout = 0');
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    // A write is what takes an exclusive lock; held in exclusive locking mode, it is kept.
    db.exec('BEGIN EXCLUSIVE');
    db.exec('CREATE TABLE IF NOT EXISTS held (since INTEGER)');
    db.exec('COMMIT');
  } catch (error) {
    db.close();
    if (error instanceof Error && /locked|busy/i.test(error.message)) throw new DataInUse(data);
    throw error;
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      db.close();
    },
  };
}
