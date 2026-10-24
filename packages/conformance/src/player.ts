// Plays scenarios against a runner written in TypeScript, through an
// adapter the runner provides.
//
// After every action the player waits for the runner to settle, then
// checks the invariants that hold after any step: log entries are numbered
// 1, 2, 3 with no gaps, and their times never go backwards. For a runner
// that keeps a journal, it also replays the journal with the probe's code:
// every entry must give the answer and digest it recorded, and the replay
// must end with the runner's log and snapshot.

import { forReplay, replay } from '@acentric/replay';
import type { JournalEntry, Json, JsonObject, LogEntry } from '@acentric/types';

import type { GateOutcome } from './hook.js';
import { mismatch } from './match.js';
import probe from './probe/agent.js';
import probeV2 from './probe/agent-v2.js';
import type { Bundle, Expectation, Feature, Scenario, ScenarioStep } from './scenario.js';

/** What a runner answered to a create, input, config change or upgrade. */
export type Answer = { accepted: true } | { rejected: Json } | { failed: Json };

export type RunningEffect = {
  key: string;
  kind: string;
  args: Json;
  attempt: number;
  abort: boolean;
};

/** What a runner provides so scenarios can drive it. One adapter plays one scenario. */
export type Adapter = {
  /** The features this runner offers. */
  supports: readonly Feature[];
  /** Creates the scenario's session from a probe bundle. */
  create(bundle: Bundle, config: JsonObject): Promise<Answer>;
  input(kind: string, payload: JsonObject): Promise<Answer>;
  configure(config: JsonObject): Promise<Answer>;
  /** Finishes the gate waiting under `key`. */
  release(key: string, outcome: GateOutcome): Promise<void>;
  /**
   * Resolves once every message that can be delivered has been, and
   * nothing runs but gates waiting to be released.
   */
  settle(): Promise<void>;
  running(): Promise<RunningEffect[]>;
  /** Keys of gates whose signal has fired. */
  signalled(): Promise<string[]>;
  log(): Promise<LogEntry[]>;
  snapshot(): Promise<JsonObject>;
  /** Stops the runner abruptly and starts it again. Needed for 'durable'. */
  crash?(): Promise<void>;
  /** Upgrades the session to version 2 of the probe. Needed for 'upgrade'. */
  upgrade?(): Promise<Answer>;
  /** The session's journal, oldest first; empty before it is created. Needed for 'journal'. */
  journal?(): Promise<JournalEntry[]>;
  /**
   * Forks the session at journal entry `at`, the newest by default, and acts
   * on the fork from then on. Needed for 'fork'.
   */
  fork?(at?: number): Promise<Answer>;
  close(): Promise<void>;
};

export type ScenarioResult =
  | { name: string; status: 'passed' }
  | { name: string; status: 'skipped'; missing: Feature[] }
  | { name: string; status: 'failed'; step: number; problem: string };

export async function play(
  scenario: Scenario,
  open: () => Promise<Adapter>,
): Promise<ScenarioResult> {
  const adapter = await open();
  try {
    const missing = (scenario.requires ?? []).filter(
      (feature) => !adapter.supports.includes(feature),
    );
    if (missing.length > 0) return { name: scenario.name, status: 'skipped', missing };
    const failure = await playFrom(adapter, scenario.steps, 0, null);
    return failure === null
      ? { name: scenario.name, status: 'passed' }
      : { name: scenario.name, status: 'failed', ...failure };
  } finally {
    await adapter.close();
  }
}

type Failure = { step: number; problem: string };

/** Plays steps one after another; each needs the runner settled from the one before. */
async function playFrom(
  adapter: Adapter,
  steps: ScenarioStep[],
  index: number,
  answer: Answer | null,
): Promise<Failure | null> {
  const step = steps[index];
  if (step === undefined) return null;
  try {
    if ('expect' in step) {
      const problem = await check(adapter, step.expect, answer);
      if (problem !== null) return { step: index, problem };
      return await playFrom(adapter, steps, index + 1, answer);
    }
    const next = await act(adapter, step, answer);
    await adapter.settle();
    const problem = invariants(await adapter.log()) ?? (await journalProblem(adapter));
    if (problem !== null) return { step: index, problem };
    return await playFrom(adapter, steps, index + 1, next);
  } catch (error) {
    return { step: index, problem: error instanceof Error ? error.message : String(error) };
  }
}

async function act(
  adapter: Adapter,
  step: Exclude<ScenarioStep, { expect: Expectation }>,
  answer: Answer | null,
): Promise<Answer | null> {
  if ('create' in step) return adapter.create(step.bundle ?? 'probe', step.create);
  if ('input' in step) return adapter.input(step.input, step.payload ?? {});
  if ('configure' in step) return adapter.configure(step.configure);
  if ('release' in step) {
    await adapter.release(step.release, step.with);
    return answer;
  }
  if ('wait' in step) {
    await new Promise((resolve) => setTimeout(resolve, step.wait));
    return answer;
  }
  if ('crash' in step) {
    if (adapter.crash === undefined) throw new Error('the adapter cannot crash the runner');
    await adapter.crash();
    return answer;
  }
  if ('fork' in step) {
    if (adapter.fork === undefined) throw new Error('the adapter cannot fork');
    return adapter.fork(step.fork.at);
  }
  if (adapter.upgrade === undefined) throw new Error('the adapter cannot upgrade');
  return adapter.upgrade();
}

/** Replays the runner's journal with the probe's code, and says how it differs. */
async function journalProblem(adapter: Adapter): Promise<string | null> {
  if (!adapter.supports.includes('journal') || adapter.journal === undefined) return null;
  const journal = await adapter.journal();
  if (journal.length === 0) {
    const log = await adapter.log();
    return log.length === 0 ? null : 'the session has a log, but its journal is empty';
  }
  const numbers = journal.map((entry) => entry.n);
  if (numbers.some((n, index) => n !== index + 1)) {
    return `the journal is numbered ${JSON.stringify(numbers)}, not 1, 2, 3...`;
  }
  const replayed = replay(journal, [forReplay(probe), forReplay(probeV2)]);
  if (replayed.differs !== null) {
    const entry = replayed.entries.find((candidate) => !candidate.same);
    return `replaying the journal differs at entry ${replayed.differs}: expected ${JSON.stringify(entry?.expected)}, got ${JSON.stringify(entry?.actual)}`;
  }
  return (
    mismatch([...replayed.simulation.log], await adapter.log(), 'the replayed log') ??
    mismatch(replayed.simulation.snapshot, await adapter.snapshot(), 'the replayed snapshot')
  );
}

async function check(
  adapter: Adapter,
  expected: Expectation,
  answer: Answer | null,
): Promise<string | null> {
  const problems: (string | null)[] = [];
  if (expected.accepted === true) {
    problems.push(
      answer !== null && 'accepted' in answer ? null : `expected accepted, got ${show(answer)}`,
    );
  }
  if (expected.rejected !== undefined) {
    if (answer === null || !('rejected' in answer))
      problems.push(`expected rejected, got ${show(answer)}`);
    else if (expected.rejected !== true)
      problems.push(mismatch(expected.rejected, answer.rejected, 'rejected'));
  }
  if (expected.failed === true) {
    problems.push(
      answer !== null && 'failed' in answer ? null : `expected a failed step, got ${show(answer)}`,
    );
  }
  if (expected.running !== undefined)
    problems.push(checkRunning(expected.running, await adapter.running()));
  if (expected.signalled !== undefined) {
    const signalled = await adapter.signalled();
    problems.push(mismatch(expected.signalled.toSorted(), signalled.toSorted(), 'signalled'));
  }
  if (expected.log !== undefined || expected.logKinds !== undefined) {
    const log = await adapter.log();
    if (expected.log !== undefined) {
      const newest = log.slice(-expected.log.length).map(({ kind, body }) => ({ kind, body }));
      problems.push(mismatch(expected.log, newest, 'log'));
    }
    if (expected.logKinds !== undefined) {
      problems.push(
        mismatch(
          expected.logKinds,
          log.map((entry) => entry.kind),
          'logKinds',
        ),
      );
    }
  }
  if (expected.snapshot !== undefined)
    problems.push(mismatch(expected.snapshot, await adapter.snapshot(), 'snapshot'));
  if (expected.journal !== undefined) {
    if (adapter.journal === undefined) throw new Error('the adapter cannot read the journal');
    const newest = (await adapter.journal()).slice(-expected.journal.length);
    problems.push(mismatch(expected.journal, newest, 'journal'));
  }
  return problems.find((problem) => problem !== null) ?? null;
}

function checkRunning(
  expected: Expectation['running'] & {},
  actual: RunningEffect[],
): string | null {
  const keys = actual.map((effect) => effect.key).toSorted();
  const wanted = expected.map((item) => (typeof item === 'string' ? item : item.key)).toSorted();
  const keysProblem = mismatch(wanted, keys, 'running');
  if (keysProblem !== null) return keysProblem;
  for (const item of expected) {
    if (typeof item === 'string') continue;
    const effect = actual.find((running) => running.key === item.key);
    const problem = mismatch(
      { ...item },
      effect === undefined ? undefined : { ...effect },
      `running.${item.key}`,
    );
    if (problem !== null) return problem;
  }
  return null;
}

function invariants(log: LogEntry[]): string | null {
  for (const [index, entry] of log.entries()) {
    if (entry.seq !== index + 1) return `log entry ${index + 1} has seq ${entry.seq}`;
    const previous = log[index - 1];
    if (previous !== undefined && entry.at < previous.at) {
      return `log entry ${entry.seq} is earlier (${entry.at}) than the one before (${previous.at})`;
    }
  }
  return null;
}

function show(answer: Answer | null): string {
  return answer === null ? 'no answer' : JSON.stringify(answer);
}
