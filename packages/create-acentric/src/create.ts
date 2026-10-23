// Creating a project from a template: copy its files, write package.json,
// and optionally initialise git and install dependencies.
//
// With `local`, the acentric packages come from a checkout of the acentric
// repository instead of the registry: each is packed into a tarball in the
// project's .acentric folder, as `npm publish` would pack it, and
// package.json points at those tarballs. That tests a project exactly as a
// published release would make it, before anything is published.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export type CreateOptions = {
  /** Where to create the project. It must not exist, or be empty. */
  dir: string;
  /** Defaults to 'minimal', the only template so far. */
  template?: string;
  packageManager?: PackageManager;
  /** Run `git init`. Defaults to true. */
  git?: boolean;
  /** Install dependencies. Defaults to true. */
  install?: boolean;
  /** A checkout of the acentric repository to take the acentric packages from. */
  local?: string;
  log?: (line: string) => void;
};

export class CreateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreateError';
  }
}

export const TEMPLATES = ['minimal'];

/** The acentric packages a project depends on directly. */
const DIRECT = ['@acentric/cli', '@acentric/testing', '@acentric/types'];
/** Every acentric package a project installs, with where it lives in the repository. */
const PACKAGES: Record<string, string> = {
  '@acentric/types': 'packages/types',
  '@acentric/testing': 'packages/testing',
  '@acentric/protocol': 'packages/protocol',
  '@acentric/client': 'packages/client',
  '@acentric/runner-local': 'runners/local',
  '@acentric/cli': 'packages/cli',
};
const TOOLS = { typescript: '^6.0.3', vitest: '^5.0.5' };

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The package manager that ran this, judged by npm_config_user_agent. */
export function detectPackageManager(
  userAgent = process.env['npm_config_user_agent'] ?? '',
): PackageManager {
  for (const manager of ['pnpm', 'yarn', 'bun'] as const)
    if (userAgent.startsWith(manager)) return manager;
  return 'npm';
}

/** How to run a package.json script with each package manager. */
export function runCommand(manager: PackageManager): string {
  return manager === 'npm' ? 'npm run' : manager === 'bun' ? 'bun run' : manager;
}

export async function createProject(
  options: CreateOptions,
): Promise<{ dir: string; name: string }> {
  const log = options.log ?? (() => undefined);
  const dir = resolve(options.dir);
  const template = options.template ?? 'minimal';
  const manager = options.packageManager ?? detectPackageManager();
  if (!TEMPLATES.includes(template)) {
    throw new CreateError(`there is no template ${template}; there is ${TEMPLATES.join(', ')}`);
  }
  if (existsSync(dir) && (await readdir(dir)).length > 0) {
    throw new CreateError(`${dir} already exists and is not empty`);
  }
  const name = packageName(basename(dir));

  log(`creating ${name} from the ${template} template`);
  await copyTemplate(join(ROOT, 'templates', template), dir, { name, run: runCommand(manager) });

  const version = await ownVersion();
  const devDependencies: Record<string, string> = { ...TOOLS };
  for (const dependency of DIRECT) devDependencies[dependency] = `^${version}`;
  const manifest: Record<string, unknown> = {
    name,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: {
      dev: 'acentric dev',
      build: 'acentric build',
      start: 'acentric start',
      test: 'vitest run',
      typecheck: 'tsc --noEmit',
    },
    devDependencies,
  };
  if (options.local !== undefined) {
    log(`packing the acentric packages from ${options.local}`);
    const tarballs = await packLocal(resolve(options.local), join(dir, '.acentric', 'packages'));
    const overrides: Record<string, string> = {};
    for (const [dependency, tarball] of Object.entries(tarballs)) {
      overrides[dependency] = `file:${relative(dir, tarball)}`;
      if (DIRECT.includes(dependency)) devDependencies[dependency] = overrides[dependency];
    }
    manifest['overrides'] = overrides;
    manifest['pnpm'] = { overrides };
    manifest['resolutions'] = overrides;
  }
  await writeFile(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  if (options.git ?? true) {
    const git = await run('git', ['init', '--quiet'], dir);
    log(git.code === 0 ? 'initialised a git repository' : 'could not run git init; skipped');
  }
  if (options.install ?? true) {
    log(`installing dependencies with ${manager}`);
    const installed = await run(manager, ['install'], dir, true);
    if (installed.code !== 0) {
      throw new CreateError(
        `${manager} install failed; the project is in ${dir}, run it again there`,
      );
    }
  }
  return { dir, name };
}

/** Copies a template, renaming _gitignore, which npm would leave out of a package, and filling in {{placeholders}}. */
async function copyTemplate(
  from: string,
  to: string,
  values: Record<string, string>,
): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name === '_gitignore' ? '.gitignore' : entry.name);
    if (entry.isDirectory()) {
      // Templates are small: their files are copied one after another.
      // oxlint-disable-next-line no-await-in-loop
      await copyTemplate(source, target, values);
    } else {
      // oxlint-disable-next-line no-await-in-loop
      const text = await readFile(source, 'utf8');
      // oxlint-disable-next-line no-await-in-loop
      await writeFile(
        target,
        text.replaceAll(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match),
      );
    }
  }
}

/** Packs each acentric package from a repository checkout, as publishing would. */
async function packLocal(repository: string, into: string): Promise<Record<string, string>> {
  await mkdir(into, { recursive: true });
  const tarballs: Record<string, string> = {};
  for (const [dependency, path] of Object.entries(PACKAGES)) {
    const packageDir = join(repository, path);
    if (!existsSync(join(packageDir, 'dist'))) {
      throw new CreateError(`${dependency} in ${repository} is not built: run pnpm build there`);
    }
    // Packing one package at a time keeps pnpm's output readable.
    // oxlint-disable-next-line no-await-in-loop
    const packed = await run('pnpm', ['pack', '--pack-destination', into], packageDir);
    const tarball = packed.stdout.trim().split('\n').at(-1)?.trim();
    if (packed.code !== 0 || tarball === undefined || !tarball.endsWith('.tgz')) {
      throw new CreateError(`could not pack ${dependency}: ${packed.stderr.trim()}`);
    }
    tarballs[dependency] = resolve(into, tarball);
  }
  return tarballs;
}

/** An npm package name made from a folder name. */
function packageName(folder: string): string {
  const name = folder
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replaceAll(/^[._-]+|-+$/g, '');
  return name === '' ? 'my-agent' : name;
}

async function ownVersion(): Promise<string> {
  const manifest: unknown = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const version: unknown =
    typeof manifest === 'object' && manifest !== null
      ? Reflect.get(manifest, 'version')
      : undefined;
  if (typeof version !== 'string') throw new CreateError('create-acentric has no version');
  return version;
}

function run(
  command: string,
  args: string[],
  cwd: string,
  inherit = false,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(command, args, {
      cwd,
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.once('error', (error) => done({ code: -1, stdout, stderr: error.message }));
    child.once('close', (code) => done({ code, stdout, stderr }));
  });
}
