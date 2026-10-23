// Finding and loading a project's config. acentric.config.ts is bundled
// with esbuild, leaving packages to be imported from the project, and the
// result imported from the project's .acentric folder so those imports
// resolve as they would from the config itself.

import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

import type { AcentricConfig, AgentConfig } from './config-types.js';

const NAMES = [
  'acentric.config.ts',
  'acentric.config.mts',
  'acentric.config.js',
  'acentric.config.mjs',
];

/** A project's config with every default filled in, and paths made absolute. */
export type Project = {
  dir: string;
  agents: (Required<Pick<AgentConfig, 'agent' | 'handlers' | 'version'>> & {
    name: string;
    provides: NonNullable<AgentConfig['provides']>;
  })[];
  store: string;
  listen: string;
  secrets: string[];
  outDir: string;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export async function loadProject(dir: string): Promise<Project> {
  const root = resolve(dir);
  const file = NAMES.map((name) => join(root, name)).find((path) => existsSync(path));
  if (file === undefined) throw new ConfigError(`no acentric.config.ts in ${root}`);
  const config = await importConfig(root, file);
  const version = await packageVersion(root);
  const agents = Object.entries(config.agents).map(([name, agent]) => {
    const agentVersion = agent.version ?? version;
    if (agentVersion === undefined) {
      throw new ConfigError(`agent ${name} has no version, and package.json has none`);
    }
    return {
      name,
      agent: resolve(root, agent.agent),
      handlers: resolve(root, agent.handlers),
      version: agentVersion,
      provides: agent.provides ?? {},
    };
  });
  if (agents.length === 0) throw new ConfigError('the config names no agents');
  const store = config.store ?? 'sqlite:.acentric/store.db';
  return {
    dir: root,
    agents,
    store: resolveStore(root, store),
    listen: config.listen ?? 'ws://127.0.0.1:7420',
    secrets: config.secrets ?? [],
    outDir: resolve(root, config.outDir ?? '.acentric/build'),
  };
}

/** A store spec with its path made absolute against the project. */
export function resolveStore(root: string, spec: string): string {
  const match = /^(sqlite|fs):(.+)$/.exec(spec);
  if (match === null) throw new ConfigError(`a store is sqlite:PATH or fs:DIR, not ${spec}`);
  return `${match[1] ?? ''}:${resolve(root, match[2] ?? '')}`;
}

async function importConfig(root: string, file: string): Promise<AcentricConfig> {
  const result = await build({
    entryPoints: [file],
    bundle: true,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    write: false,
    logLevel: 'silent',
  });
  const code = result.outputFiles[0]?.text;
  if (code === undefined) throw new ConfigError(`could not bundle ${file}`);
  const dir = join(root, '.acentric');
  await mkdir(dir, { recursive: true });
  const compiled = join(dir, `config.${Date.now()}.mjs`);
  await writeFile(compiled, code);
  let module: unknown;
  try {
    module = await import(pathToFileURL(compiled).href);
  } finally {
    await rm(compiled, { force: true });
  }
  const config: unknown =
    typeof module === 'object' && module !== null ? Reflect.get(module, 'default') : undefined;
  if (!isConfig(config)) throw new ConfigError(`${file} has no default export with agents`);
  return config;
}

function isConfig(value: unknown): value is AcentricConfig {
  if (typeof value !== 'object' || value === null) return false;
  const agents: unknown = Reflect.get(value, 'agents');
  return (
    typeof agents === 'object' &&
    agents !== null &&
    Object.values(agents).every(
      (agent: unknown) =>
        typeof agent === 'object' &&
        agent !== null &&
        typeof Reflect.get(agent, 'agent') === 'string' &&
        typeof Reflect.get(agent, 'handlers') === 'string',
    )
  );
}

async function packageVersion(root: string): Promise<string | undefined> {
  const path = join(root, 'package.json');
  if (!existsSync(path)) return undefined;
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  const version: unknown =
    typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'version') : undefined;
  return typeof version === 'string' ? version : undefined;
}
