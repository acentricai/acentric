// create-acentric without installing anything: the files it writes, what it
// refuses, the command itself, and the tarballs it packs with --local.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { createProject, detectPackageManager, runCommand } from '../dist/index.js';

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const REPOSITORY = fileURLToPath(new URL('../../..', import.meta.url));

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'create-acentric-'));
  cleanups.push(dir);
  return dir;
}

function run(
  args: string[],
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('create-acentric', () => {
  it('writes the minimal template as a project', async () => {
    const dir = join(await workspace(), 'My Notes!');
    const created = await createProject({
      dir,
      packageManager: 'pnpm',
      git: false,
      install: false,
    });
    expect(created.name).toBe('my-notes');
    const files = await readdir(dir);
    expect(files.toSorted()).toEqual([
      '.gitignore',
      'README.md',
      'acentric.config.ts',
      'package.json',
      'src',
      'test',
      'tsconfig.json',
    ]);
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toContain('.acentric/');
    const readme = await readFile(join(dir, 'README.md'), 'utf8');
    expect(readme).toMatch(/^# my-notes$/m);
    expect(readme).toContain('pnpm dev');
    expect(readme).not.toContain('{{');
    const manifest: unknown = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    expect(manifest).toMatchObject({
      name: 'my-notes',
      private: true,
      type: 'module',
      scripts: {
        dev: 'acentric dev',
        build: 'acentric build',
        start: 'acentric start',
        test: 'vitest run',
      },
      devDependencies: {
        '@acentric/cli': '^0.1.0',
        '@acentric/testing': '^0.1.0',
        '@acentric/types': '^0.1.0',
      },
    });
  });

  it('refuses a folder that is not empty, and a template that does not exist', async () => {
    const dir = await workspace();
    await writeFile(join(dir, 'keep.txt'), 'mine');
    await expect(createProject({ dir, git: false, install: false })).rejects.toThrow(/not empty/);
    await expect(
      createProject({ dir: join(dir, 'other'), template: 'chat', git: false, install: false }),
    ).rejects.toThrow(/no template chat/);
  });

  it('knows how each package manager runs scripts', () => {
    expect(detectPackageManager('pnpm/12.3.4 npm/? node/v26')).toBe('pnpm');
    expect(detectPackageManager('yarn/4.0.0 npm/? node/v26')).toBe('yarn');
    expect(detectPackageManager('bun/1.2.0')).toBe('bun');
    expect(detectPackageManager('')).toBe('npm');
    expect([runCommand('npm'), runCommand('pnpm'), runCommand('yarn'), runCommand('bun')]).toEqual([
      'npm run',
      'pnpm',
      'yarn',
      'bun run',
    ]);
  });

  it('runs as a command, asking nothing with --yes', async () => {
    const dir = await workspace();
    const result = await run(
      ['notes-app', '--yes', '--no-install', '--no-git', '--pm', 'npm'],
      dir,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('created notes-app');
    expect(result.stdout).toContain('npm install');
    expect(result.stdout).toContain('npm run dev');
    expect(existsSync(join(dir, 'notes-app', 'src', 'agent.ts'))).toBe(true);
    const refused = await run(['notes-app', '--yes', '--no-install', '--no-git'], dir);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/not empty/);
  });

  it('packs the acentric packages from a checkout with --local, as publishing would', async () => {
    const dir = join(await workspace(), 'local-app');
    await mkdir(dir);
    await createProject({ dir, local: REPOSITORY, git: false, install: false });
    const tarballs = (await readdir(join(dir, '.acentric', 'packages'))).toSorted();
    expect(tarballs).toEqual([
      'acentric-cli-0.1.0.tgz',
      'acentric-client-0.1.0.tgz',
      'acentric-protocol-0.1.0.tgz',
      'acentric-runner-local-0.1.0.tgz',
      'acentric-testing-0.1.0.tgz',
      'acentric-types-0.1.0.tgz',
    ]);
    const manifest: unknown = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    expect(manifest).toMatchObject({
      devDependencies: { '@acentric/cli': 'file:.acentric/packages/acentric-cli-0.1.0.tgz' },
      overrides: {
        '@acentric/runner-local': 'file:.acentric/packages/acentric-runner-local-0.1.0.tgz',
      },
    });
  });
});
