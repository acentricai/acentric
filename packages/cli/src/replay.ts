// acentric replay: replays a session's journal and says where it differs.
//
// Faithful replay runs in the runner, which has the code of every version
// the session ran. What-if replay runs here: it builds the project's code
// for the session's agent and replays the journal on it from init, to show
// what that code would have done with the same inputs and effect results.

import { pathToFileURL } from 'node:url';

import type { RunnerClient } from '@acentric/client';
import { forReplay, replay } from '@acentric/replay';
import type { ReplayAgent, ReplayedEntry } from '@acentric/replay';
import type { JournalEntry } from '@acentric/types';

import { buildAgent } from './build.js';
import type { Project } from './config.js';
import type { Output } from './inspect.js';

/** The most differing entries what-if replay lists. */
const SHOWN = 20;

/** Replays the session on the code that ran it. True if every entry gave what the journal recorded. */
export async function faithful(client: RunnerClient, out: Output, id: string): Promise<boolean> {
  const report = await client.replay(id);
  if (report.differs === null) {
    out(`replayed ${report.entries} entries: each gave what the journal recorded`);
    return true;
  }
  const { n, type, expected, actual } = report.differs;
  out(`replayed ${report.entries} entries: entry ${n} (${type}) differs`);
  out(`  expected ${side(expected)}, got ${actual === null ? 'nothing' : side(actual)}`);
  return false;
}

/** Replays the session on the project's code. True if it would have done the same. */
export async function whatIf(
  client: RunnerClient,
  out: Output,
  log: Output,
  project: Project,
  id: string,
): Promise<boolean> {
  const session = await client.get(id);
  const agent = project.agents.find((candidate) => candidate.name === session.agent.name);
  if (agent === undefined) {
    throw new Error(`the project has no agent ${session.agent.name}, which session ${id} runs`);
  }
  log(`building ${agent.name}@${agent.version}`);
  const built = await buildAgent(project, agent);
  const code = await importAgent(`${built.dir}/agent.js`);
  const journal = await readJournal(client, id);
  const result = replay(journal, code, { mode: 'what-if' });
  const label = `${agent.name}@${agent.version}`;
  const different = result.entries.filter((entry) => !entry.same);
  if (different.length === 0) {
    out(`replayed ${journal.length} entries on ${label}: it would have done the same`);
    return true;
  }
  out(
    `replayed ${journal.length} entries on ${label}: ${different.length} would differ, the first at entry ${different[0]?.n}`,
  );
  const byN = new Map(journal.map((entry) => [entry.n, entry]));
  for (const entry of different.slice(0, SHOWN)) out(`  ${describe(entry, byN.get(entry.n))}`);
  if (different.length > SHOWN) out(`  and ${different.length - SHOWN} more`);
  return false;
}

async function readJournal(client: RunnerClient, id: string): Promise<JournalEntry[]> {
  const entries: JournalEntry[] = [];
  let after = 0;
  for (;;) {
    // The journal is read a page at a time, in order.
    // oxlint-disable-next-line no-await-in-loop
    const page = await client.journal(id, { after });
    entries.push(...page.entries);
    const last = page.entries.at(-1);
    if (page.cursor === undefined || last === undefined) return entries;
    after = last.n;
  }
}

/** The built pure half. It is pure, so importing it here is safe. */
async function importAgent(path: string): Promise<ReplayAgent> {
  const module: unknown = await import(`${pathToFileURL(path).href}?${Date.now()}`);
  const agent: unknown =
    typeof module === 'object' && module !== null ? Reflect.get(module, 'default') : undefined;
  if (
    typeof agent !== 'object' ||
    agent === null ||
    typeof Reflect.get(agent, 'init') !== 'function' ||
    typeof Reflect.get(agent, 'step') !== 'function'
  ) {
    throw new Error(`${path} has no default export with init and step`);
  }
  // Checked above as far as a replay needs: an object with init and step.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return forReplay(agent as ReplayAgent);
}

/** One line for a differing entry: what it was, and both sides. */
function describe(entry: ReplayedEntry, recorded: JournalEntry | undefined): string {
  let what: string = entry.type;
  if (recorded?.type === 'step') {
    const { message } = recorded;
    what =
      message.type === 'input'
        ? `input ${message.kind}`
        : message.type === 'effect'
          ? `effect ${message.key}`
          : message.type;
  }
  const actual = entry.actual === null ? 'nothing' : side(entry.actual);
  return `#${entry.n} ${what}: expected ${side(entry.expected)}, got ${actual}`;
}

function side(value: { answer: string; digest: string | null }): string {
  return value.digest === null ? value.answer : `${value.answer} ${value.digest.slice(0, 12)}`;
}
