import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LogEntry } from '@acentric/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openFileStore } from '../dist/index.js';
import type { StepCommit } from '../dist/index.js';
import { describeStore } from './store-suite.js';

describeStore('filesystem', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acentric-files-'));
  return {
    open: () => openFileStore(join(dir, 'store')),
    remove: () => rm(dir, { recursive: true, force: true }),
  };
});

describeStore('filesystem, checkpointing every line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acentric-files-'));
  return {
    open: () => openFileStore(join(dir, 'store'), { checkpointEvery: 1 }),
    remove: () => rm(dir, { recursive: true, force: true }),
  };
});

function entry(seq: number): LogEntry {
  return { seq, at: seq, kind: 'note', body: { seq } };
}
const step = (seq: number, n: number): StepCommit => ({
  expectedSeq: seq,
  snapshot: { n },
  append: [entry(seq)],
  started: [],
  finished: [],
  aborted: [],
});

describe('the filesystem store after a crash', () => {
  const session = {
    id: 'i1',
    agent: { name: 'echo', version: '1' },
    config: {},
    snapshot: { n: 0 },
    nextSeq: 1,
    fault: null,
    createHash: 'c',
    createdAt: 1,
  };

  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'acentric-files-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const journal = (): string => join(dir, 'store', 'sessions', 'i1', 'journal.jsonl');

  it('cuts off a last line a crash left half written', async () => {
    const store = await openFileStore(join(dir, 'store'));
    await store.create(session, { append: [entry(1)], started: [], journal: [] });
    await store.commit('i1', step(2, 1));
    await store.close();
    const before = await readFile(journal(), 'utf8');
    await appendFile(journal(), '0123456789abcdef {"t":"commit","step":{"expectedSeq":3,');

    const again = await openFileStore(join(dir, 'store'));
    expect(await again.load('i1')).toMatchObject({ snapshot: { n: 1 }, nextSeq: 3 });
    expect(await readFile(journal(), 'utf8')).toBe(before);
    await again.commit('i1', step(3, 2));
    expect((await again.readLog('i1')).map((e) => e.seq)).toEqual([1, 2, 3]);
    await again.close();
  });

  it('refuses a journal damaged before its last line', async () => {
    const store = await openFileStore(join(dir, 'store'));
    await store.create(session, { append: [entry(1)], started: [], journal: [] });
    await store.commit('i1', step(2, 1));
    await store.close();
    const lines = (await readFile(journal(), 'utf8')).split('\n');
    lines[0] = lines[0]?.replace('"n":0', '"n":7') ?? '';
    await writeFile(journal(), lines.join('\n'));
    const again = await openFileStore(join(dir, 'store'));
    await expect(again.load('i1')).rejects.toMatchObject({ code: 'invalid' });
    await again.close();
  });

  it('takes over a lock left by a process that is gone', async () => {
    const child = spawn(process.execPath, ['-e', '']);
    const pid = child.pid ?? 0;
    await new Promise((resolve) => child.once('exit', resolve));
    await mkdir(join(dir, 'store'), { recursive: true });
    await writeFile(join(dir, 'store', 'lock'), String(pid));
    const store = await openFileStore(join(dir, 'store'));
    expect(await readFile(join(dir, 'store', 'lock'), 'utf8')).toBe(String(process.pid));
    await store.close();
  });

  it('replays the journal after its latest checkpoint', async () => {
    const store = await openFileStore(join(dir, 'store'), { checkpointEvery: 3 });
    await store.create(session, { append: [entry(1)], started: [], journal: [] });
    for (let seq = 2; seq <= 8; seq += 1) {
      // Each commit follows the one before.
      // oxlint-disable-next-line no-await-in-loop
      await store.commit('i1', step(seq, seq));
    }
    await store.close();
    const checkpoint: unknown = JSON.parse(
      await readFile(join(dir, 'store', 'sessions', 'i1', 'checkpoint.json'), 'utf8'),
    );
    expect(checkpoint).toMatchObject({ record: { nextSeq: 8 } });
    const again = await openFileStore(join(dir, 'store'), { checkpointEvery: 3 });
    expect(await again.load('i1')).toMatchObject({ snapshot: { n: 8 }, nextSeq: 9 });
    expect((await again.readLog('i1', { after: 5 })).map((e) => e.seq)).toEqual([6, 7, 8]);
    await again.close();
  });

  it('writes journals a person can read', async () => {
    const store = await openFileStore(join(dir, 'store'));
    await store.create(session, { append: [entry(1)], started: [], journal: [] });
    await store.close();
    const [line] = (await readFile(journal(), 'utf8')).trim().split('\n');
    expect(line).toMatch(/^[0-9a-f]{16} \{"t":"create","session":\{"id":"i1"/);
  });
});
