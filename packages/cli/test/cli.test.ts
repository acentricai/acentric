// acentric build and start on small projects written for each test, and
// the command itself run as a process against a started runner.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectWebSocket } from '@acentric/client';
import { afterEach, describe, expect, it } from 'vitest';

import { buildProject, loadProject, startProject } from '../dist/index.js';
import type { Started } from '../dist/index.js';

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

// A project: an agent whose `note` input logs its payload and whose `ask`
// input declares an effect, with handlers that use Node.
const files = (agent = AGENT, handlers = HANDLERS, extra = ''): Record<string, string> => ({
  'package.json': JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module' }),
  'acentric.config.ts': `export default { agents: { notes: { agent: 'src/agent.ts', handlers: 'src/handlers.ts'${extra} } } };`,
  'src/shared.ts': 'export const label = (text: string): string => `note: ${text}`;',
  'src/agent.ts': agent,
  'src/handlers.ts': handlers,
});

const AGENT = `
import { label } from './shared.js';
type Snapshot = { asks: { key: string; kind: string }[] };
export default {
  kinds: ['clock'],
  init: () => ({ snapshot: { asks: [] } as Snapshot }),
  step: (state: { snapshot: Snapshot }, message: any) => {
    const fetch = 'a local named fetch is not the global';
    if (message.type === 'input' && message.kind === 'note') {
      return { snapshot: state.snapshot, append: [{ kind: 'note', body: { text: label(String(message.payload.text)), fetch } }] };
    }
    if (message.type === 'input' && message.kind === 'ask') {
      return { snapshot: { asks: [...state.snapshot.asks, { key: String(message.payload.key), kind: 'clock' }] } };
    }
    if (message.type === 'effect') {
      return { snapshot: { asks: state.snapshot.asks.filter((a) => a.key !== message.key) }, append: [{ kind: 'result', body: message.outcome }] };
    }
    if (message.type === 'input') return { error: 'unknown input ' + message.kind };
    return { snapshot: state.snapshot };
  },
  effects: ({ snapshot }: { snapshot: Snapshot }) => snapshot.asks.map((a) => ({ key: a.key, kind: a.kind, args: null })),
};
`;

const HANDLERS = `
import { hostname } from 'node:os';
export default {
  clock: { mode: 'reissue', run: async () => ({ host: hostname().length > 0 }) },
};
`;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function project(contents: Record<string, string> = files()): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'acentric-cli-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(contents)) {
    // Writing a handful of small files, one after another.
    // oxlint-disable-next-line no-await-in-loop
    await mkdir(join(dir, path, '..'), { recursive: true });
    // oxlint-disable-next-line no-await-in-loop
    await writeFile(join(dir, path), text);
  }
  return dir;
}

async function started(dir: string): Promise<Started & { lines: string[] }> {
  const lines: string[] = [];
  const runner = await startProject(await loadProject(dir), {
    listen: 'ws://127.0.0.1:0',
    log: (line) => lines.push(line),
  });
  cleanups.unshift(() => runner.close());
  return { ...runner, lines };
}

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const buildError = async (contents: Record<string, string>): Promise<string> => {
  const dir = await project(contents);
  const error: unknown = await buildProject(await loadProject(dir), { typecheck: false }).then(
    () => null,
    (thrown: unknown) => thrown,
  );
  return error instanceof Error ? error.message : 'built';
};

describe('acentric build', () => {
  it('bundles each agent into a self-contained pure half, handlers and a manifest', async () => {
    const dir = await project();
    const [built] = await buildProject(await loadProject(dir), { typecheck: false });
    const out = join(dir, '.acentric', 'build', 'notes');
    expect(built?.dir).toBe(out);
    const agent = await readFile(join(out, 'agent.js'), 'utf8');
    expect(agent).not.toMatch(/^\s*import\s/m);
    expect(agent).toContain('note: ');
    expect(JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'))).toEqual({
      name: 'notes',
      version: '1.0.0',
      hash: built?.manifest.hash,
      kinds: ['clock'],
      handlers: { clock: { mode: 'reissue' } },
      provides: {},
    });
    expect(built?.warnings).toEqual([]);
  });

  it('refuses a pure half that does I/O', async () => {
    expect(
      await buildError(files(`${AGENT}\nexport const leak = () => fetch('https://example.com');`)),
    ).toMatch(/uses fetch, which a step must not/);
    expect(
      await buildError(
        files(`import { readFileSync } from 'node:fs';\n${AGENT}\nexport const r = readFileSync;`),
      ),
    ).toMatch(/may not import Node modules/);
    expect(
      await buildError(
        files(`${AGENT}\nexport const t = () => globalThis.setTimeout(() => 0, 1);`),
      ),
    ).toMatch(/uses setTimeout/);
  });

  it('warns about a pure half that reads the clock or randomness', async () => {
    const dir = await project(
      files(`${AGENT}\nexport const now = () => Date.now() + Math.random();`),
    );
    const [built] = await buildProject(await loadProject(dir), { typecheck: false });
    expect(built?.warnings).toHaveLength(2);
    expect(built?.warnings.join('\n')).toMatch(/Date\.now/);
    expect(built?.warnings.join('\n')).toMatch(/Math\.random/);
  });

  it('checks that every kind the agent lists is handled or provided', async () => {
    const mail = AGENT.replace("kinds: ['clock']", "kinds: ['clock', 'mail']");
    expect(await buildError(files(mail))).toMatch(/uses mail, which nothing handles or provides/);
    const dir = await project(files(mail, HANDLERS, ", provides: { mail: { mode: 'once' } }"));
    const [built] = await buildProject(await loadProject(dir), { typecheck: false });
    expect(built?.manifest.provides).toEqual({ mail: { mode: 'once' } });
    expect(
      await buildError(
        files(AGENT, "export default { '@clock': { mode: 'reissue', run: async () => 1 } };"),
      ),
    ).toMatch(/belong to runners/);
  });
});

describe('acentric start', () => {
  it('deploys the built agents once and serves them', async () => {
    const dir = await project();
    await buildProject(await loadProject(dir), { typecheck: false });
    const first = await started(dir);
    expect(first.lines).toContain('deployed notes@1.0.0');
    const client = await connectWebSocket(first.url ?? '');
    const { id } = await client.create('notes@1.0.0', {});
    expect(await client.input(id ?? '', { kind: 'note', payload: { text: 'hi' } })).toEqual({
      accepted: true,
    });
    await client.close();
    await first.close();
    cleanups.shift();

    const second = await started(dir);
    expect(second.lines).toContain('already deployed: notes@1.0.0');
    const again = await connectWebSocket(second.url ?? '');
    expect((await again.log(id ?? '')).entries.map((entry) => entry.body)).toEqual([
      { text: 'note: hi', fetch: 'a local named fetch is not the global' },
    ]);
    await again.close();
  });

  it('keeps sessions in a folder of plain files with an fs: store', async () => {
    const dir = await project(files(AGENT, HANDLERS, ''));
    await writeFile(
      join(dir, 'acentric.config.ts'),
      "export default { store: 'fs:.acentric/files', agents: { notes: { agent: 'src/agent.ts', handlers: 'src/handlers.ts' } } };",
    );
    await buildProject(await loadProject(dir), { typecheck: false });
    const runner = await started(dir);
    const client = await connectWebSocket(runner.url ?? '');
    const { id } = await client.create('notes@1.0.0', {});
    await client.input(id ?? '', { kind: 'note', payload: { text: 'on disk' } });
    await client.close();
    const journal = await readFile(
      join(dir, '.acentric', 'files', 'sessions', id ?? '', 'journal.jsonl'),
      'utf8',
    );
    expect(journal).toContain('note: on disk');
    expect(
      existsSync(join(dir, '.acentric', 'files', 'agents', 'notes', '1.0.0', 'agent.js')),
    ).toBe(true);
  });

  it('refuses a build that does not match the config', async () => {
    const dir = await project();
    await expect(startProject(await loadProject(dir))).rejects.toThrow(
      /not built: run acentric build/,
    );
    await buildProject(await loadProject(dir), { typecheck: false });
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '2.0.0' }),
    );
    await expect(startProject(await loadProject(dir))).rejects.toThrow(
      /built as 1.0.0 but the config says 2.0.0/,
    );
  });
});

describe('the acentric command', () => {
  it('builds, then creates, sends, lists, gets and prints the log', async () => {
    const dir = await project();
    const build = await run(['build', '-C', dir]);
    expect(build.code).toBe(0);
    expect(build.stdout).toMatch(/^notes@1\.0\.0 {2}[0-9a-f]{12} {2}/);
    expect(existsSync(join(dir, '.acentric', 'build', 'notes', 'agent.js'))).toBe(true);

    const runner = await started(dir);
    const url = ['--url', runner.url ?? ''];
    expect((await run(['agents', ...url])).stdout).toMatch(
      /^notes@1\.0\.0 {2}[0-9a-f]{12} {2}0 sessions/,
    );
    const id = (await run(['create', 'notes@1.0.0', '{}', ...url])).stdout.trim();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await run(['send', id, 'note', '{"text":"one"}', ...url])).stdout.trim()).toBe(
      '{"accepted":true}',
    );
    const rejected = await run(['send', id, 'nope', ...url]);
    expect(rejected.code).toBe(1);
    expect(rejected.stdout.trim()).toBe('{"rejected":"unknown input nope"}');
    await run(['send', id, 'ask', '{"key":"c1"}', ...url]);
    await expect
      .poll(async () => (await run(['log', id, ...url])).stdout)
      .toMatch(/#2 .* result {2}\{"ok":\{"host":true\}\}/);
    expect((await run(['ls', ...url])).stdout).toMatch(
      new RegExp(`^${id} {2}notes@1\\.0\\.0 {2}idle {2}2 entries`),
    );
    expect(JSON.parse((await run(['get', id, '--snapshot', ...url])).stdout)).toMatchObject({
      status: 'idle',
      snapshot: { asks: [] },
    });
    const json = (await run(['log', id, '--json', ...url])).stdout.trim().split('\n');
    expect(json.map((line) => Reflect.get(Object(JSON.parse(line)), 'kind'))).toEqual([
      'note',
      'result',
    ]);
  });

  it('says how to use it, and fails clearly', async () => {
    expect((await run([])).code).toBe(2);
    const unknown = await run(['frobnicate', '--url', 'ws://127.0.0.1:1']);
    expect(unknown.stderr).toMatch(/no runner at ws:\/\/127\.0\.0\.1:1/);
    const dir = await project();
    const missing = await run(['send', 'x', '--url', 'ws://127.0.0.1:1', '-C', dir]);
    expect(missing.code).not.toBe(0);
  });
});
