// acentric build: turns each agent in a project into the bundle a runner
// deploys, in <outDir>/<name>/:
//
//   agent.js       the pure half, with everything it imports; it may import
//                  no Node module and use no global that does I/O
//   handlers.js    the handlers, with their dependencies; Node built-ins allowed
//   manifest.json  name, version, hash, the kinds the agent uses and the
//                  kinds the bundle covers
//
// The pure half's globals are checked by bundling it a second time with
// each forbidden global defined as a marker: esbuild replaces only free
// references, so a marker in the output is a real use of the global, not a
// local variable or property of the same name.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';
import type { BuildFailure } from 'esbuild';

import type { Project } from './config.js';

/** Globals the pure half must not use: they do I/O, or reach the world outside a step. */
const FORBIDDEN = [
  'fetch',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'clearTimeout',
  'clearInterval',
  'clearImmediate',
  'queueMicrotask',
  'process',
  'require',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'navigator',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'Deno',
  'Bun',
];

/** Globals that make a step's result differ between runs: allowed, with a warning. */
const NONDETERMINISTIC = [
  'Date.now',
  'Math.random',
  'performance.now',
  'crypto.getRandomValues',
  'crypto.randomUUID',
];

/** Kinds every runner provides. */
const RUNNER_KINDS = new Set(['@timer']);

export type KindSettings = { mode: 'reissue' | 'once'; timeoutMs?: number; maxAttempts?: number };

export type Manifest = {
  name: string;
  version: string;
  /** The hash the runner gives the bundle when it is deployed. */
  hash: string;
  /** The kinds the agent lists, or null if it lists none. */
  kinds: string[] | null;
  handlers: Record<string, KindSettings>;
  provides: Record<string, KindSettings>;
};

export type BuiltAgent = { manifest: Manifest; dir: string; warnings: string[] };

export class BuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuildError';
  }
}

export type BuildOptions = {
  /** Type-check the project first, with its own TypeScript. Defaults to true when it has a tsconfig.json. */
  typecheck?: boolean;
  /** Where progress goes. */
  log?: (line: string) => void;
};

export async function buildProject(
  project: Project,
  options: BuildOptions = {},
): Promise<BuiltAgent[]> {
  const log = options.log ?? (() => undefined);
  if (options.typecheck ?? existsSync(join(project.dir, 'tsconfig.json'))) {
    log('type-checking');
    await typecheck(project.dir);
  }
  const built: BuiltAgent[] = [];
  for (const agent of project.agents) {
    log(`building ${agent.name}@${agent.version}`);
    // Agents are built one at a time, so their errors read in order.
    // oxlint-disable-next-line no-await-in-loop
    built.push(await buildAgent(project, agent));
  }
  return built;
}

/** Builds one agent into <project.outDir>/<name>/. */
export async function buildAgent(
  project: Project,
  agent: Project['agents'][number],
): Promise<BuiltAgent> {
  const label = `${agent.name}@${agent.version}`;
  const warnings: string[] = [];
  const agentSource = await bundle(agent.agent, 'neutral', `${label}'s pure half`);
  const marked = await bundle(agent.agent, 'neutral', `${label}'s pure half`, markers());
  const forbidden = found(marked, '__acentric_forbidden__');
  if (forbidden.length > 0) {
    throw new BuildError(
      `${label}'s pure half uses ${forbidden.join(', ')}, which a step must not: I/O belongs in handlers`,
    );
  }
  for (const name of found(marked, '__acentric_nondeterministic__')) {
    warnings.push(
      `${label}'s pure half uses ${name.replace('_', '.')}: steps should use the \`now\` they are given`,
    );
  }
  const handlersSource = await bundle(agent.handlers, 'node', `${label}'s handlers`);

  const dir = join(project.outDir, agent.name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'agent.js'), agentSource);
  await writeFile(join(dir, 'handlers.js'), handlersSource);

  const kinds = await agentKinds(join(dir, 'agent.js'), label);
  const handlers = await handlerKinds(join(dir, 'handlers.js'), label);
  for (const kind of Object.keys(agent.provides)) {
    if (kind in handlers || kind.startsWith('@')) {
      throw new BuildError(`${label} provides ${kind}, but it is the bundle's or the runner's`);
    }
  }
  const missing = (kinds ?? []).filter(
    (kind) => !(kind in handlers) && !(kind in agent.provides) && !RUNNER_KINDS.has(kind),
  );
  if (missing.length > 0) {
    throw new BuildError(`${label} uses ${missing.join(', ')}, which nothing handles or provides`);
  }
  const manifest: Manifest = {
    name: agent.name,
    version: agent.version,
    hash: digest([agent.name, agent.version, agentSource, handlersSource, agent.provides]),
    kinds,
    handlers,
    provides: agent.provides,
  };
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, dir, warnings };
}

async function bundle(
  entry: string,
  platform: 'neutral' | 'node',
  what: string,
  define?: Record<string, string>,
): Promise<string> {
  try {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      platform,
      target: 'es2022',
      write: false,
      logLevel: 'silent',
      ...(platform === 'neutral'
        ? { mainFields: ['module', 'main'], conditions: ['import', 'default'] }
        : {}),
      ...(platform === 'node'
        ? {
            // CommonJS dependencies still call require for Node built-ins.
            banner: {
              js: "import { createRequire as __acentricRequire } from 'node:module'; const require = __acentricRequire(import.meta.url);",
            },
          }
        : {}),
      ...(define === undefined ? {} : { define }),
    });
    const output = result.outputFiles[0];
    if (output === undefined) throw new BuildError(`esbuild produced nothing for ${what}`);
    if (platform === 'neutral' && /^\s*import\s/m.test(output.text)) {
      throw new BuildError(
        `${what} still imports a module after bundling; it must be self-contained`,
      );
    }
    return output.text;
  } catch (error) {
    if (isBuildFailure(error)) {
      const problems = error.errors.map((problem) => {
        const where =
          problem.location === null ? '' : `${problem.location.file}:${problem.location.line}: `;
        return `${where}${problem.text}`;
      });
      const node =
        platform === 'neutral' &&
        problems.some((problem) => /Could not resolve "node:|built-in/.test(problem));
      throw new BuildError(
        `could not bundle ${what}:\n  ${problems.join('\n  ')}${node ? '\n  The pure half may not import Node modules: that I/O belongs in handlers.' : ''}`,
      );
    }
    throw error;
  }
}

function markers(): Record<string, string> {
  const define: Record<string, string> = {};
  for (const name of FORBIDDEN) {
    define[name] = `__acentric_forbidden__.${name}`;
    define[`globalThis.${name}`] = `__acentric_forbidden__.${name}`;
  }
  for (const name of NONDETERMINISTIC) {
    define[name] = `__acentric_nondeterministic__.${name.replace('.', '_')}`;
  }
  return define;
}

function found(code: string, marker: string): string[] {
  const names = new Set<string>();
  for (const match of code.matchAll(new RegExp(`${marker}\\.(\\w+)`, 'g')))
    names.add(match[1] ?? '');
  return [...names].toSorted();
}

/** The kinds the pure half lists. It is pure, so importing it here is safe. */
async function agentKinds(path: string, label: string): Promise<string[] | null> {
  const module: unknown = await import(`${pathToFileURL(path).href}?${Date.now()}`);
  const agent: unknown =
    typeof module === 'object' && module !== null ? Reflect.get(module, 'default') : undefined;
  if (
    typeof agent !== 'object' ||
    agent === null ||
    typeof Reflect.get(agent, 'init') !== 'function' ||
    typeof Reflect.get(agent, 'step') !== 'function'
  ) {
    throw new BuildError(`${label}'s pure half has no default export with init and step`);
  }
  const kinds: unknown = Reflect.get(agent, 'kinds');
  if (kinds === undefined) return null;
  if (!Array.isArray(kinds) || !kinds.every((kind) => typeof kind === 'string')) {
    throw new BuildError(`${label}'s kinds is not a list of names`);
  }
  return kinds.filter((kind) => typeof kind === 'string');
}

/** Reads the handlers' kinds in a child process, since loading handlers may do I/O. */
async function handlerKinds(path: string, label: string): Promise<Record<string, KindSettings>> {
  const script = `
    const module = await import(${JSON.stringify(pathToFileURL(path).href)});
    const handlers = module.default;
    if (typeof handlers !== 'object' || handlers === null) throw new Error('no default export of handlers');
    const kinds = {};
    for (const [kind, def] of Object.entries(handlers)) {
      if (kind.startsWith('@')) throw new Error('handler names starting with @ belong to runners: ' + kind);
      if (def?.mode !== 'reissue' && def?.mode !== 'once') throw new Error('handler ' + kind + ' has no mode');
      if (typeof def.run !== 'function') throw new Error('handler ' + kind + ' has no run function');
      kinds[kind] = { mode: def.mode, ...(def.timeoutMs === undefined ? {} : { timeoutMs: def.timeoutMs }), ...(def.maxAttempts === undefined ? {} : { maxAttempts: def.maxAttempts }) };
    }
    process.stdout.write(JSON.stringify(kinds));
    process.exit(0);
  `;
  const { code, stdout, stderr } = await run(process.execPath, [
    '--input-type=module',
    '-e',
    script,
  ]);
  if (code !== 0) {
    const reason = /Error: (.+)/.exec(stderr)?.[1] ?? stderr.trim();
    throw new BuildError(`${label}'s handlers could not be loaded: ${reason}`);
  }
  const parsed: unknown = JSON.parse(stdout);
  if (typeof parsed !== 'object' || parsed === null)
    throw new BuildError(`${label}'s handlers described nothing`);
  const kinds: Record<string, KindSettings> = {};
  for (const [kind, settings] of Object.entries(parsed)) {
    const mode: unknown = Reflect.get(settings, 'mode');
    const timeoutMs: unknown = Reflect.get(settings, 'timeoutMs');
    const maxAttempts: unknown = Reflect.get(settings, 'maxAttempts');
    kinds[kind] = {
      mode: mode === 'once' ? 'once' : 'reissue',
      ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
      ...(typeof maxAttempts === 'number' ? { maxAttempts } : {}),
    };
  }
  return kinds;
}

/** Type-checks a project with its own TypeScript. */
async function typecheck(dir: string): Promise<void> {
  const tsc = findTsc(dir);
  if (tsc === null) {
    throw new BuildError(
      'the project has a tsconfig.json but no TypeScript installed: install it, or pass --no-typecheck',
    );
  }
  const { code, stdout, stderr } = await run(tsc, ['--noEmit', '-p', dir], dir);
  if (code !== 0) throw new BuildError(`type errors:\n${(stdout + stderr).trim()}`);
}

/** The nearest TypeScript compiler, looking up from the project as Node resolves packages. */
function findTsc(dir: string): string | null {
  for (let at = dir; ; at = dirname(at)) {
    const tsc = join(at, 'node_modules', '.bin', 'tsc');
    if (existsSync(tsc)) return tsc;
    if (dirname(at) === at) return null;
  }
}

function run(
  command: string,
  args: string[],
  cwd?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isBuildFailure(error: unknown): error is BuildFailure {
  return error instanceof Error && Array.isArray(Reflect.get(error, 'errors'));
}
