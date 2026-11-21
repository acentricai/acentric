// A real process, on a real database on disk, killed with no warning at every point where an
// actor's state changes, and at every wait in between. Then a new process on the same database.
//
// Whatever the point, the same must hold at the end: both turns are whole, each message is
// there once, and the tool did its work at most once unless it said it is safe to do again.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { databases } from './temp.ts';

const HOST = fileURLToPath(new URL('./crash-host.ts', import.meta.url));
const database = databases();

type Outcome = {
  readonly recovered: number;
  readonly status: string;
  readonly lastTurn: string;
  readonly turn: string;
  readonly seqs: readonly number[];
  readonly roles: readonly string[];
  readonly results: readonly { readonly call: string; readonly isError: boolean }[];
};

function host(db: string, ...more: string[]) {
  return spawnSync(process.execPath, [HOST, '--db', db, '--ledger', `${db}.ledger`, ...more], {
    encoding: 'utf8',
    timeout: 30_000,
  });
}

/** Kills a process at `point`, starts another on what it left, and gives how that one ended. */
function crashAt(point: string, ...more: string[]) {
  const db = database();
  const first = host(db, '--crash', point, ...more);
  const second = host(db, ...more);
  const ledger = existsSync(`${db}.ledger`)
    ? readFileSync(`${db}.ledger`, 'utf8').trim().split('\n')
    : [];
  return {
    killed: first.signal,
    exit: second.status,
    stderr: second.stderr,
    outcome: (second.status === 0 ? JSON.parse(second.stdout) : undefined) as Outcome,
    /** How many times the tool did its work for each of the two calls. */
    ran: [1, 2].map((asked) => ledger.filter((line) => line === JSON.stringify({ asked })).length),
  };
}

// Two turns are eight commits, four calls of the model, two of the tool and two inputs.
const POINTS = [
  ...[1, 2, 3, 4, 5, 6, 7, 8].flatMap((n) => [
    `before-commit:${String(n)}`,
    `after-commit:${String(n)}`,
  ]),
  ...[1, 2, 3, 4].map((n) => `in-model:${String(n)}`),
  ...[1, 2].map((n) => `in-tool:${String(n)}`),
  ...[1, 2].map((n) => `after-input:${String(n)}`),
];

const WHOLE = ['user', 'assistant', 'tool_result', 'assistant'];

describe('a process that is killed', () => {
  it('runs both turns to the end when it is not killed', () => {
    const db = database();
    const run = host(db);
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      recovered: 0,
      status: 'idle',
      lastTurn: 'ok',
      turn: 'idle',
      seqs: [1, 2, 3, 4, 5, 6, 7, 8],
      roles: [...WHOLE, ...WHOLE],
      results: [
        { call: 'call-1', isError: false },
        { call: 'call-2', isError: false },
      ],
    });
  });

  it.each(POINTS)('at %s: the next process ends with both turns whole', (point) => {
    const { killed, exit, stderr, outcome, ran } = crashAt(point);

    // The point was reached, and the process ended there.
    expect(killed).toBe('SIGKILL');
    expect(exit, stderr).toBe(0);
    expect(outcome).toMatchObject({ status: 'idle', lastTurn: 'ok', turn: 'idle' });
    // Each message is there once, in its place.
    expect(outcome.roles).toEqual([...WHOLE, ...WHOLE]);
    expect(outcome.seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(outcome.results.map((result) => result.call)).toEqual(['call-1', 'call-2']);

    // The tool is not safe to call again, so it did its work once at most for each call. Where
    // it is said to have answered, it did it exactly once.
    const answered = outcome.results.map((result) => (result.isError ? 0 : 1));
    for (const [index, times] of ran.entries()) {
      expect(times, `call ${String(index + 1)} ran`).toBeLessThanOrEqual(1);
      expect(times, `call ${String(index + 1)} ran`).toBeGreaterThanOrEqual(
        answered[index] as number,
      );
    }
  });

  it.each(['in-tool:1', 'in-tool:2', 'after-commit:2', 'after-commit:6'])(
    'at %s, with a tool that is safe to call again: the tool is called again, and answers',
    (point) => {
      const { killed, exit, stderr, outcome, ran } = crashAt(point, '--retry-safe');

      expect(killed).toBe('SIGKILL');
      expect(exit, stderr).toBe(0);
      expect(outcome.roles).toEqual([...WHOLE, ...WHOLE]);
      expect(outcome.results).toEqual([
        { call: 'call-1', isError: false },
        { call: 'call-2', isError: false },
      ]);
      // Twice for the call it was killed in: once before, and once again after.
      expect(ran.toSorted()).toEqual(point.startsWith('in-tool') ? [1, 2] : [1, 1]);
    },
  );

  it('during a tool that is not safe to call again: the model is told it may or may not have run', () => {
    const { outcome, ran } = crashAt('in-tool:1');
    expect(outcome.results).toEqual([
      { call: 'call-1', isError: true },
      { call: 'call-2', isError: false },
    ]);
    expect(ran).toEqual([1, 1]);
  });
});
