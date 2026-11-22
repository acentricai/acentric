// A project: a folder with `acentric.json`, which names its agents and the file each is in. It
// is found by looking up from where the command runs, so a monorepo can have its agents in one
// place or in several:
//
//   { "agents": { "support": "agents/support.ts", "reviewer": "packages/review/agent.ts" } }
//
// Paths are from the folder `acentric.json` is in.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { nameSchema } from '@acentric/protocol';

import { Fail } from './fail.ts';

export const CONFIG = 'acentric.json';

export type Project = {
  /** The folder of `acentric.json`. */
  readonly root: string;
  /** Each agent's name, and its file from `root`, in the order they are written. */
  readonly agents: readonly (readonly [string, string])[];
};

/** Whether `name` is one an agent may have, as the engine takes one. */
const isAgentName = (name: string): boolean => nameSchema.safeParse(name).success;

export function checkAgentName(name: string): string {
  if (!isAgentName(name)) {
    throw new Fail(
      `${JSON.stringify(name)} is not an agent's name`,
      'it has 1 to 63 lowercase letters, digits, _ or -, and starts with a letter or a digit',
    );
  }
  return name;
}

/** What `acentric.json` says, checked. */
export function parseProject(root: string, text: string): Project {
  const wrong = (why: string) => new Fail(`${join(root, CONFIG)} ${why}`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw wrong('is not JSON');
  }
  const agents = (value as { agents?: unknown } | null)?.agents;
  if (typeof agents !== 'object' || agents === null || Array.isArray(agents)) {
    throw wrong('has no "agents": { "<agent>": "<its file>" }');
  }
  const pairs: (readonly [string, string])[] = [];
  for (const [name, file] of Object.entries(agents)) {
    if (!isAgentName(name)) {
      throw wrong(`names an agent ${JSON.stringify(name)}, which is not an agent's name`);
    }
    if (typeof file !== 'string' || file === '') throw wrong(`gives no file for the agent ${name}`);
    pairs.push([name, file]);
  }
  return { root, agents: pairs };
}

/** The project `from` is in: the nearest folder above it, or itself, with `acentric.json`. */
export function findProject(from: string): Project | undefined {
  let dir = resolve(from);
  for (;;) {
    const file = join(dir, CONFIG);
    if (existsSync(file)) return parseProject(dir, readFileSync(file, 'utf8'));
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** The project a command runs in. It fails, saying how to start one, where there is none. */
export function theProject(from: string): Project {
  const project = findProject(from);
  if (project === undefined) {
    throw new Fail(`no ${CONFIG} here or above`, 'start a project with `acentric init`');
  }
  return project;
}

export function writeProject(project: Project): void {
  const agents = Object.fromEntries(project.agents);
  writeFileSync(join(project.root, CONFIG), `${JSON.stringify({ agents }, null, 2)}\n`);
}
