// What the commands of a project do: signing in, starting a project, and deploying it. They
// write what they did to `out`, and throw `Fail` for what they could not do.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { BUNDLE_PROTOCOL } from '@acentric/protocol';

import { bundle, sdkVersion } from './bundle.ts';
import { engineUrl, removeCredentials, writeCredentials } from './credentials.ts';
import { reachOf, signedIn, whoOf, withEngine } from './engine.ts';
import type { Io } from './engine.ts';
import { Fail } from './fail.ts';
import { CONFIG, checkAgentName, findProject, theProject, writeProject } from './project.ts';
import { GITIGNORE, TSCONFIG, VERSIONS, agentFile } from './templates.ts';
import { AGENT_FILES, AGENT_VERSION } from './vendored.ts';

// Signing in

export async function login(
  io: Io,
  given: { readonly url?: string | undefined; readonly key?: string | undefined },
): Promise<void> {
  // An install from an engine says which one it was, so that it need not be said again.
  const url = given.url ?? io.env['ACENTRIC_ENGINE'];
  if (url === undefined || url === '') {
    throw new Fail('say which engine: `acentric login <engine address>`');
  }
  const engine = engineUrl(url);
  const key = (
    given.key ??
    io.env['ENGINE_API_KEY'] ??
    (await io.secret(`API key for ${engine}: `))
  ).trim();
  if (key === '')
    throw new Fail('no key was given', 'the engine printed one when it first started');
  const me = await withEngine({ engine, key }, (client) => client.call('me.get'));
  const file = writeCredentials(io.env, { engine, key });
  io.out(`Signed in to ${engine} ${whoOf(me)}, which reaches ${reachOf(me)}.`);
  io.out(`Kept in ${file}.`);
}

export function logout(io: Io): void {
  io.out(
    removeCredentials(io.env)
      ? 'Signed out: the key is forgotten here. It goes on working until it is revoked.'
      : 'Not signed in.',
  );
}

export async function whoami(io: Io): Promise<void> {
  const credentials = signedIn(io);
  const me = await withEngine(credentials, (client) => client.call('me.get'));
  io.out(`${credentials.engine}, ${whoOf(me)}, which reaches ${reachOf(me)}`);
  io.out(`It may: ${me.permissions.join(', ')}`);
}

// A project

/** The package manager the folder is set up for, from the lockfile nearest above it. */
function packageManager(dir: string): 'pnpm' | 'yarn' | 'bun' | 'npm' {
  for (let at = resolve(dir); ; at = dirname(at)) {
    if (existsSync(join(at, 'pnpm-lock.yaml')) || existsSync(join(at, 'pnpm-workspace.yaml'))) {
      return 'pnpm';
    }
    if (existsSync(join(at, 'yarn.lock'))) return 'yarn';
    if (existsSync(join(at, 'bun.lock')) || existsSync(join(at, 'bun.lockb'))) return 'bun';
    if (existsSync(join(at, 'package-lock.json'))) return 'npm';
    if (dirname(at) === at) return 'npm';
  }
}

/** Writes the agent package into `root`/vendor/agent, in place of what was there. */
function vendorAgent(root: string): void {
  const target = join(root, 'vendor', 'agent');
  rmSync(target, { recursive: true, force: true });
  for (const [path, text] of Object.entries(AGENT_FILES)) {
    mkdirSync(dirname(join(target, path)), { recursive: true });
    writeFileSync(join(target, path), text);
  }
}

type Named = { readonly [name: string]: string };

/** The project's package.json, with what an agent needs added to whatever it has. */
function packageJson(root: string, name: string): string {
  const file = join(root, 'package.json');
  const current = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as { readonly [field: string]: unknown })
    : {};
  const dependencies: { [name: string]: string } = { ...(current['dependencies'] as Named) };
  const devDependencies: { [name: string]: string } = { ...(current['devDependencies'] as Named) };
  dependencies['@acentric/agent'] = 'file:./vendor/agent';
  dependencies['zod'] ??= VERSIONS.zod;
  devDependencies['esbuild'] ??= VERSIONS.esbuild;
  devDependencies['typescript'] ??= VERSIONS.typescript;
  const scripts: { [name: string]: string } = { ...(current['scripts'] as Named) };
  scripts['typecheck'] ??= 'tsc --noEmit';
  scripts['deploy'] ??= 'acentric deploy';
  const next = {
    name,
    private: true,
    type: 'module',
    ...current,
    scripts,
    dependencies,
    devDependencies,
  };
  return `${JSON.stringify(next, null, 2)}\n`;
}

/** Writes `text` to `file` unless it is there already. Says whether it wrote. */
function writeNew(file: string, text: string): boolean {
  if (existsSync(file)) return false;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return true;
}

export function init(
  io: Io,
  given: {
    readonly dir?: string | undefined;
    readonly agent?: string | undefined;
    readonly install: boolean;
  },
): void {
  const root = resolve(io.cwd, given.dir ?? '.');
  const existing = findProject(root);
  if (existing?.root === root) {
    throw new Fail(
      `${join(root, CONFIG)} is there already`,
      'add an agent to it with `acentric add <agent>`',
    );
  }
  const name = checkAgentName(
    given.agent ??
      basename(root)
        .toLowerCase()
        .replaceAll(/[^a-z0-9_-]+/g, '-')
        .replace(/^[^a-z0-9]+/, ''),
  );
  mkdirSync(root, { recursive: true });

  const file = `agents/${name}.ts`;
  writeNew(join(root, file), agentFile(name));
  writeProject({ root, agents: [[name, file]] });
  writeFileSync(join(root, 'package.json'), packageJson(root, name));
  vendorAgent(root);
  writeNew(join(root, 'tsconfig.json'), TSCONFIG);
  writeNew(join(root, '.gitignore'), GITIGNORE);
  const where = relative(io.cwd, root) || '.';
  io.out(
    `Made a project in ${where}, with the agent ${name} in ${file}, and the agent package ${AGENT_VERSION} in vendor/agent.`,
  );

  if (given.install) {
    const manager = packageManager(root);
    io.out(`Installing its packages with ${manager}…`);
    const result = spawnSync(manager, ['install'], { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) {
      throw new Fail(`\`${manager} install\` did not succeed`, `run it yourself in ${where}`);
    }
  } else {
    io.out('Install its packages (`npm install`) before deploying.');
  }
  io.out(`Then: \`acentric deploy\`${where === '.' ? '' : `, in ${where}`}.`);
}

export function add(
  io: Io,
  given: { readonly agent: string; readonly file?: string | undefined },
): void {
  const project = theProject(io.cwd);
  const name = checkAgentName(given.agent);
  if (project.agents.some(([each]) => each === name)) {
    throw new Fail(`the project has an agent ${name} already`);
  }
  // A file named from where the command runs, written into the project from its root.
  const file = relative(
    project.root,
    given.file === undefined
      ? join(project.root, 'agents', `${name}.ts`)
      : resolve(io.cwd, given.file),
  );
  const wrote = writeNew(join(project.root, file), agentFile(name));
  writeProject({ root: project.root, agents: [...project.agents, [name, file]] });
  io.out(`Added the agent ${name}, in ${file}${wrote ? '' : ', which was there already'}.`);
}

// Deploying

export async function deploy(
  io: Io,
  given: { readonly agents: readonly string[]; readonly dryRun: boolean },
): Promise<void> {
  const project = theProject(io.cwd);
  for (const name of given.agents) {
    if (!project.agents.some(([each]) => each === name)) {
      throw new Fail(
        `the project has no agent ${name}`,
        `its agents: ${project.agents.map(([each]) => each).join(', ')}`,
      );
    }
  }
  const chosen =
    given.agents.length === 0
      ? project.agents
      : project.agents.filter(([name]) => given.agents.includes(name));
  const credentials = given.dryRun ? undefined : signedIn(io);
  const failed: string[] = [];
  for (const [name, file] of chosen) {
    try {
      const code = await bundle(project.root, file);
      const size = `${(Buffer.byteLength(code) / 1024).toFixed(1)} KB`;
      if (credentials === undefined) {
        io.out(`${name}: bundled ${file}, ${size}`);
        continue;
      }
      const manifest = { protocol: BUNDLE_PROTOCOL, sdk: sdkVersion(project.root) };
      const deployed = await withEngine(credentials, (client) =>
        client.call('deployments.create', { body: { agent: name, manifest, code } }),
      );
      const { version, definition } = deployed.deployment;
      if (!deployed.created) {
        io.out(`${name}: unchanged, still v${String(version)}`);
      } else {
        // Every agent takes a message, whether it has a `message` of its own or not.
        const inputs = [
          'message',
          ...definition.inputs.map((input) => input.type).filter((type) => type !== 'message'),
        ];
        const what = `${String(definition.tools.length)} tools · inputs ${inputs.join(', ')}`;
        io.out(`${name}: deployed as v${String(version)} (${size}) · ${what}`);
      }
      if (deployed.missingSecrets.length > 0) {
        // Its code would fail where it reads one: said now, and how to set it.
        io.out(
          `  it reads secrets that are not set: ${deployed.missingSecrets.join(', ')} (\`acentric secrets set ${name} <NAME>\`)`,
        );
      }
    } catch (error) {
      if (!(error instanceof Fail)) throw error;
      failed.push(name);
      io.out(`${name}: ${error.message}${error.hint === undefined ? '' : ` (${error.hint})`}`);
    }
  }
  if (failed.length > 0) {
    throw new Fail(`${failed.join(', ')} ${failed.length === 1 ? 'was' : 'were'} not deployed`);
  }
}
