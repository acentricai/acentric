// Replays a session's journal with no runner: each entry is delivered again,
// at its `now`, and what it left is compared with what the journal recorded.
//
// Faithful replay, the default, runs each entry on the version that ran it,
// so it reproduces what happened and checks that it does. What-if replay
// runs every entry on one agent from init, skipping recorded upgrades and
// their `migrated` messages, to see what that code would have done with the
// same inputs and effect results.

import type {
  Agent,
  JournalAnswer,
  JournalEntry,
  JsonObject,
  Kinds,
  LogEntry,
} from '@acentric/types';

import { journalDigest } from './digest.js';
import { simulate } from './simulate.js';
import type { Simulation } from './simulate.js';

/** An agent with its types erased, so versions with different snapshots replay together. */
export type ReplayAgent = Agent<JsonObject, JsonObject>;

/** Erases an agent's types for `replay`. */
export function forReplay<S extends JsonObject, C extends JsonObject, K extends Kinds>(
  agent: Agent<S, C, K>,
): ReplayAgent {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return agent as unknown as ReplayAgent;
}

export type ReplayOptions = {
  /** `faithful`, the default, or `what-if`, which runs every entry on the first agent given. */
  mode?: 'faithful' | 'what-if';
};

/** What one entry did, against what the journal recorded. */
export type ReplayedEntry = {
  n: number;
  type: JournalEntry['type'];
  expected: { answer: JournalAnswer; digest: string | null };
  /** Null for an entry what-if replay skips: an upgrade, or its `migrated` message. */
  actual: { answer: JournalAnswer; digest: string | null } | null;
  same: boolean;
};

export type Replay = {
  entries: ReplayedEntry[];
  /** The `n` of the first entry whose answer or digest differs, or null. */
  differs: number | null;
  /** The session as the replay left it: its snapshot, config, log and running effects. */
  simulation: Simulation<JsonObject, JsonObject, Kinds>;
};

/**
 * Replays `journal`, from its `init` entry, with `agents`: every version the
 * journal names for faithful replay, or the agent to run for what-if.
 * Throws if the journal does not start with `init`, or names a version
 * faithful replay was not given.
 */
export function replay(
  journal: readonly JournalEntry[],
  agents: ReplayAgent | readonly ReplayAgent[],
  options: ReplayOptions = {},
): Replay {
  const given: readonly ReplayAgent[] = Array.isArray(agents) ? agents : [agents];
  const whatIf = options.mode === 'what-if';
  const code = (version: string): ReplayAgent => {
    const agent = whatIf ? given[0] : given.find((candidate) => candidate.version === version);
    if (agent === undefined) throw new Error(`replay was not given version ${version}`);
    return agent;
  };

  const [first, ...rest] = journal;
  if (first?.type !== 'init') throw new Error('a journal starts with its init entry');
  let simulation = simulate(code(first.version), first.config, { now: first.now });
  const entries: ReplayedEntry[] = [
    compare(first, { answer: 'accepted', digest: digestOf(simulation, simulation.log) }),
  ];

  for (const entry of rest) {
    if (entry.type === 'init')
      throw new Error(`a journal has one init entry, but ${entry.n} is one`);
    simulation.advance(entry.now - simulation.now);
    if (entry.type === 'upgrade') {
      if (whatIf) {
        entries.push(compare(entry, null));
        continue;
      }
      simulation = simulation.upgrade(code(entry.version), { migrated: false });
      entries.push(compare(entry, { answer: 'accepted', digest: digestOf(simulation, []) }));
      continue;
    }
    if (whatIf && entry.message.type === 'migrated') {
      entries.push(compare(entry, null));
      continue;
    }
    entries.push(compare(entry, deliver(simulation, entry)));
  }

  return {
    entries,
    differs: entries.find((entry) => !entry.same)?.n ?? null,
    simulation,
  };
}

/** Delivers a step entry's message, and says how step answered and what it left. */
function deliver(
  simulation: Simulation<JsonObject, JsonObject, Kinds>,
  entry: Extract<JournalEntry, { type: 'step' }>,
): { answer: JournalAnswer; digest: string | null } {
  const { message } = entry;
  try {
    const delivery =
      message.type === 'config'
        ? simulation.configure(message.config)
        : simulation.send(message, message.type === 'effect' ? message.key : null);
    if (delivery.rejected !== null) return { answer: 'rejected', digest: null };
    return { answer: 'accepted', digest: digestOf(simulation, delivery.appended) };
  } catch {
    // A step that throws, or returns what a runner refuses, changes nothing.
    return { answer: 'failed', digest: null };
  }
}

function digestOf(
  simulation: Simulation<JsonObject, JsonObject, Kinds>,
  appended: readonly LogEntry[],
): string {
  return journalDigest(simulation.snapshot, simulation.config, appended);
}

function compare(
  entry: JournalEntry,
  actual: { answer: JournalAnswer; digest: string | null } | null,
): ReplayedEntry {
  const expected = {
    answer: entry.type === 'step' ? entry.answer : ('accepted' as const),
    digest: entry.digest ?? null,
  };
  const same =
    actual === null || (actual.answer === expected.answer && actual.digest === expected.digest);
  return { n: entry.n, type: entry.type, expected, actual, same };
}
