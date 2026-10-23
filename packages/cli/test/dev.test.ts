// acentric dev on a small project, editing its files while an instance is
// mid-conversation: saves hot-reload the instance, keeping its log; saving
// a fix clears a fault; a build that fails leaves the code as it was.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connectWebSocket } from '@acentric/client';
import type { RunnerClient } from '@acentric/client';
import type { Json } from '@acentric/types';
import { afterEach, describe, expect, it } from 'vitest';

import { devProject, loadProject } from '../dist/index.js';
import type { DevEvent, DevServer } from '../dist/index.js';

// `note` logs its payload with a label; `ask` declares a `clock` effect,
// whose result step throws while shared.ts says the code is broken.
const shared = (label: string, broken = false): string =>
  `export const label = (text: string): string => '${label}' + text;\nexport const broken = ${broken};`;

const AGENT = `
import { broken, label } from './shared.js';
type Snapshot = { asks: { key: string; ms: number }[] };
export default {
  kinds: ['clock'],
  init: () => ({ snapshot: { asks: [] } as Snapshot }),
  step: (state: { snapshot: Snapshot }, message: any) => {
    if (message.type === 'input' && message.kind === 'note') {
      return { snapshot: state.snapshot, append: [{ kind: 'note', body: label(String(message.payload.text)) }] };
    }
    if (message.type === 'input' && message.kind === 'ask') {
      const ask = { key: String(message.payload.key), ms: Number(message.payload.ms ?? 0) };
      return { snapshot: { asks: [...state.snapshot.asks, ask] } };
    }
    if (message.type === 'effect') {
      if (broken) throw new Error('a bug in the result step');
      return {
        snapshot: { asks: state.snapshot.asks.filter((ask) => ask.key !== message.key) },
        append: [{ kind: 'result', body: { by: label(''), outcome: message.outcome } }],
      };
    }
    if (message.type === 'input') return { error: 'unknown input ' + message.kind };
    return { snapshot: state.snapshot };
  },
  effects: ({ snapshot }: { snapshot: Snapshot }) => snapshot.asks.map((ask) => ({ key: ask.key, kind: 'clock', args: { ms: ask.ms } })),
  view: ({ snapshot }: { snapshot: Snapshot }) => ({ asks: snapshot.asks.length }),
};
`;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    // Closing in order: clients, then the dev server, then its files.
    // oxlint-disable-next-line no-await-in-loop
    await cleanup();
  }
});

type Setup = { dir: string; dev: DevServer; client: RunnerClient };

async function setup(broken = false): Promise<Setup> {
  const dir = await mkdtemp(join(tmpdir(), 'acentric-dev-'));
  await mkdir(join(dir, 'src'));
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module' }),
  );
  await writeFile(
    join(dir, 'acentric.config.ts'),
    "export default { agents: { notes: { agent: 'src/agent.ts', handlers: 'src/handlers.ts' } } };",
  );
  await writeFile(join(dir, 'src', 'shared.ts'), shared('note: ', broken));
  await writeFile(join(dir, 'src', 'agent.ts'), AGENT);
  await writeFile(
    join(dir, 'src', 'handlers.ts'),
    "export default { clock: { mode: 'reissue', run: async (ctx: any) => { await new Promise((r) => setTimeout(r, ctx.args.ms)); return 'tick'; } } };",
  );
  const dev = await devProject(await loadProject(dir), { port: 0 });
  const client = await connectWebSocket(dev.wsUrl);
  cleanups.push(
    () => client.close(),
    () => dev.close(),
    () => rm(dir, { recursive: true, force: true }),
  );
  return { dir, dev, client };
}

async function created(s: Setup): Promise<string> {
  const { id } = await s.client.create(
    { name: 'notes', version: s.dev.versions()['notes'] ?? '' },
    {},
  );
  if (id === undefined) throw new Error('not created');
  return id;
}

/** Saves shared.ts and waits for the upgrade of `id` it causes. */
async function save(
  s: Setup,
  text: string,
  id: string,
): Promise<Extract<DevEvent, { type: 'upgraded' }>> {
  const upgraded = s.dev.next((event) => event.type === 'upgraded' && event.instance === id);
  await writeFile(join(s.dir, 'src', 'shared.ts'), text);
  const event = await upgraded;
  if (event.type !== 'upgraded') throw new Error('not an upgrade');
  return event;
}

async function until(what: string, condition: () => Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  // Waiting on the dev server, a little at a time.
  // oxlint-disable-next-line no-await-in-loop
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const bodies = async (s: Setup, id: string): Promise<Json[]> =>
  (await s.client.log(id)).entries.map((entry) => entry.body);

describe('acentric dev', () => {
  it('hot-reloads an instance mid-conversation, keeping its log', async () => {
    const s = await setup();
    const first = s.dev.versions()['notes'];
    expect(first).toMatch(/^1\.0\.0-dev\.[0-9a-f]{12}$/);
    const id = await created(s);
    await s.client.input(id, { kind: 'note', payload: { text: 'one' } });

    const upgraded = await save(s, shared('NOTE: '), id);
    expect(upgraded).toMatchObject({ from: first, answer: { accepted: true } });
    const second = s.dev.versions()['notes'];
    expect(second).not.toBe(first);
    expect(upgraded.to).toBe(second);

    await s.client.input(id, { kind: 'note', payload: { text: 'two' } });
    expect(await bodies(s, id)).toEqual(['note: one', 'NOTE: two']);
    expect((await s.client.get(id)).agent.version).toBe(second);
    expect((await s.client.listAgents()).map((agent) => agent.version)).toEqual([second]);
  });

  it('reloads while an effect runs: the new code steps its result', async () => {
    const s = await setup();
    const id = await created(s);
    await s.client.input(id, { kind: 'ask', payload: { key: 'slow', ms: 2000 } });
    await until('the effect to run', async () =>
      (await s.client.get(id)).running.some((effect) => effect.active),
    );
    const upgraded = await save(s, shared('NOTE: '), id);
    expect(upgraded.answer).toEqual({ accepted: true });
    expect((await s.client.get(id)).running.map((effect) => effect.key)).toEqual(['slow']);
    await until('the result', async () => (await bodies(s, id)).length === 1, 8000);
    expect(await bodies(s, id)).toEqual([{ by: 'NOTE: ', outcome: { ok: 'tick' } }]);
  });

  it('clears a fault when the fix is saved, stepping the failed result again', async () => {
    const s = await setup(true);
    const id = await created(s);
    await s.client.input(id, { kind: 'ask', payload: { key: 'c1' } });
    await until('the fault', async () => (await s.client.get(id)).status === 'faulted');
    expect((await s.client.get(id)).fault).toMatch(/a bug in the result step/);

    const upgraded = await save(s, shared('note: ', false), id);
    expect(upgraded.answer).toEqual({ accepted: true });
    await until('the retried result', async () => (await bodies(s, id)).length === 1);
    expect(await bodies(s, id)).toEqual([{ by: 'note: ', outcome: { ok: 'tick' } }]);
    expect((await s.client.get(id)).status).toBe('idle');
  });

  it('keeps instances on their code when a build fails', async () => {
    const s = await setup();
    const version = s.dev.versions()['notes'];
    const id = await created(s);
    const failed = s.dev.next((event) => event.type === 'build_failed');
    await writeFile(join(s.dir, 'src', 'shared.ts'), 'export const label = (;');
    expect(await failed).toMatchObject({
      type: 'build_failed',
      agent: 'notes',
      error: expect.stringMatching(/shared\.ts/),
    });
    await s.client.input(id, { kind: 'note', payload: { text: 'still' } });
    expect(await bodies(s, id)).toEqual(['note: still']);
    expect((await s.client.get(id)).agent.version).toBe(version);
  });

  it('serves the dev UI, its script and its state', async () => {
    const s = await setup();
    const page = await fetch(s.dev.url);
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    expect(await page.text()).toContain('<script type="module" src="/app.js">');
    const script = await fetch(`${s.dev.url}/app.js`);
    expect(script.status).toBe(200);
    expect(await script.text()).toContain('acentric-dev:');
    const state: unknown = await (await fetch(`${s.dev.url}/dev/state`)).json();
    expect(state).toMatchObject({ versions: { notes: s.dev.versions()['notes'] } });
  });
});
