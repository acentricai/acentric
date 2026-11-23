// What the executor that keeps code apart does that the other cannot: against real workerd
// processes. Kept small: a few processes, a few deployments, a few hundred calls.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NO_MACHINE } from '@acentric/core';
import type { CallContext, CallResult } from '@acentric/core';
import { BUNDLE_PROTOCOL, makeId } from '@acentric/protocol';
import type { DeploymentId, Json } from '@acentric/protocol';

import { BundleError, IsolateExecutor, UnsupportedProtocol } from '../src/index.ts';
import type { IsolateOptions } from '../src/index.ts';
import { allowedNetworks } from '../src/isolate/config.ts';
import { sandboxesOf } from '../src/isolate/pool.ts';
import { bundle } from './bundle.ts';

const source = (fill: number) => ({
  now: 1_795_305_600_000,
  random: new Uint8Array(10).fill(fill),
});
const agent = { id: makeId('agent', source(1)), name: 'support' };
const context: CallContext = {
  agent: agent.id,
  actor: makeId('actor', source(2)),
  actorName: null,
  externalId: null,
  configuration: null,
  modelId: 'fake-1',
  reasoning: 'medium',
  machine: null,
};
let made = 0;
const deploymentId = (): DeploymentId => {
  made += 1;
  return makeId('deployment', {
    now: 1_795_305_600_000,
    random: Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, made >> 8, made & 255]),
  });
};
const signal = () => new AbortController().signal;
const text = (result: CallResult): string =>
  result.ok ? String(result.value) : `not ok: ${JSON.stringify(result)}`;
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('It never happened');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

let code: string;
let server: { readonly url: string; close(): Promise<void> };
const executors: IsolateExecutor[] = [];

/** An executor with the agent loaded, and a way to call its tools. */
async function start(options: IsolateOptions = {}) {
  const executor = await IsolateExecutor.start({ processes: 1, log: () => {}, ...options });
  executors.push(executor);
  const load = async (more = '') => {
    const deployment = deploymentId();
    await executor.load(deployment, { code: `${code}\n${more}`, agent });
    return deployment;
  };
  const deployment = await load();
  const tool = (
    name: string,
    argument: Json = {},
    on: DeploymentId = deployment,
    stop: AbortSignal = signal(),
  ) => executor.call(on, `tools.${name}.execute`, argument, context, stop, NO_MACHINE);
  return { executor, deployment, load, tool };
}

beforeAll(async () => {
  code = await bundle('sandboxed');
  const http = createServer((_request, response) => {
    response.end('hello from this machine');
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  server = {
    url: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => {
          resolve();
        });
      }),
  };
}, 30_000);

afterAll(async () => {
  await Promise.all(executors.map((executor) => executor.close()));
  await server.close();
});

describe('code kept apart', () => {
  it('has the web platform, and nothing of Node', async () => {
    const { tool } = await start();
    expect(JSON.parse(text(await tool('platform')))).toEqual({
      fetch: 'function',
      crypto: 'object',
      setTimeout: 'function',
      process: 'undefined',
      Buffer: 'undefined',
      require: 'undefined',
    });
  });

  it('is refused when it is loaded, with why: it needs Node, exports no agent, or is no agent', async () => {
    const executor = await IsolateExecutor.start({ processes: 1, log: () => {} });
    executors.push(executor);
    const load = (given: string) => executor.load(deploymentId(), { code: given, agent });

    await expect(load('import fs from "node:fs"; export default fs;')).rejects.toThrow(
      /does not load[\s\S]*node:fs/,
    );
    await expect(load('throw new Error("on load")')).rejects.toThrow(/does not load[\s\S]*on load/);
    await expect(load('this is not JavaScript')).rejects.toBeInstanceOf(BundleError);
    await expect(load('export const agent = 1;')).rejects.toThrow(/exports no agent/);
    await expect(load('export default { provider: "openai" };')).rejects.toMatchObject({
      code: 'invalid_agent',
    });
    const newer = `export default { [Symbol.for('acentric.bundle')]: { protocol: ${String(BUNDLE_PROTOCOL + 1)}, describe() { return {}; }, call() {} } };`;
    await expect(load(newer)).rejects.toBeInstanceOf(UnsupportedProtocol);
    await expect(load(newer)).rejects.toThrow(/this engine runs 1/);
    // A schema written by hand: it says what it takes, and takes anything.
    const schema =
      '{ "~standard": { validate: (value) => ({ value }), jsonSchema: { input: () => ({ type: "object" }) } } }';
    const twice = code.replace(
      'tools: [',
      `tools: [{ name: "echo", description: "Again.", parameters: ${schema}, execute: () => "" }, `,
    );
    await expect(load(twice)).rejects.toThrow(/Two tools are named echo/);
  });

  it('is forgotten when it is unloaded', async () => {
    const { executor, deployment, tool } = await start();
    expect(text(await tool('echo', { text: 'hello' }))).toBe('hello');
    executor.unload(deployment);
    await expect(tool('echo', { text: 'hello' })).rejects.toThrow(/not loaded/);
  });

  it('is sent, and answers, more than fits in one message', async () => {
    const { tool } = await start();
    const long = 'x'.repeat(700_000);
    expect(text(await tool('echo', { text: long }))).toBe(long);
  });

  it('takes 200 calls at once', async () => {
    const { executor, tool } = await start();
    const answers = await Promise.all(
      Array.from({ length: 200 }, (_, index) => tool('echo', { text: String(index) })),
    );
    expect(answers.map(text)).toEqual(Array.from({ length: 200 }, (_, index) => String(index)));
    expect(executor.stats().processes[0]?.inFlight).toBe(0);
  });

  it('is given a secret when it asks for one, for the agent it is of', async () => {
    const asked: string[] = [];
    const { tool } = await start({
      secrets: (of, name) => {
        asked.push(`${of}/${name}`);
        return name === 'ORDERS_API_KEY' ? 'k-1' : undefined;
      },
    });
    expect(text(await tool('secret', { name: 'ORDERS_API_KEY' }))).toBe('k-1');
    expect(asked).toEqual([`${agent.id}/ORDERS_API_KEY`]);
    // One that is not set is the agent's code's to make something of.
    expect(await tool('secret', { name: 'NONE' })).toMatchObject({
      ok: false,
      kind: 'error',
      error: { name: 'SecretNotSet' },
    });
  });
});

describe('the network', () => {
  it('is public addresses, and the private ones that are let, as workerd names them', () => {
    expect(allowedNetworks({ reach: 'public' })).toEqual(['public']);
    expect(
      allowedNetworks({ reach: 'public', allow: ['10.0.0.0/8', '192.168.1.7', 'fd00::/8'] }),
    ).toEqual(['public', '10.0.0.0/8', '192.168.1.7/32', 'fd00::/8']);
    expect(allowedNetworks({ reach: 'any' })).toEqual(['public', 'private', 'local']);
    for (const not of ['orders.internal', '10.0.0.0/33', '10.0.0/8', '', '10.0.0.1/8/8']) {
      expect(() => allowedNetworks({ reach: 'public', allow: [not] }), not).toThrow(TypeError);
    }
  });

  it('does not reach this machine unless it is let', async () => {
    const { tool } = await start();
    const refused = await tool('fetch', { url: server.url });
    expect(refused).toMatchObject({ ok: false, kind: 'error' });
  });

  it('reaches a private address that is let, and any address when all are', async () => {
    const listed = await start({ network: { reach: 'public', allow: ['127.0.0.1'] } });
    expect(text(await listed.tool('fetch', { url: server.url }))).toBe(
      '200 hello from this machine',
    );
    const any = await start({ network: { reach: 'any' } });
    expect(text(await any.tool('fetch', { url: server.url }))).toBe('200 hello from this machine');
  });

  it('refuses to start with what is no address in its list', async () => {
    await expect(
      IsolateExecutor.start({ network: { reach: 'public', allow: ['orders.internal'] } }),
    ).rejects.toThrow(/not an address/);
  });
});

describe('a call that is given up', () => {
  it('ends at once for whoever waited, though its code runs on, and is counted until it ends', async () => {
    const { executor, tool } = await start();
    await tool('echo', { text: 'loaded' });
    const stop = new AbortController();
    const started = Date.now();
    const waiting = tool('sleep', { ms: 600 }, undefined, stop.signal);
    await waitFor(() => executor.stats().processes[0]?.inFlight === 1);
    stop.abort();
    expect(await waiting).toMatchObject({ ok: false, error: { name: 'AbortError' } });
    expect(Date.now() - started).toBeLessThan(500);
    expect(executor.stats().processes[0]).toMatchObject({ abandoned: 1, inFlight: 0 });
    await waitFor(() => executor.stats().processes[0]?.abandoned === 0);
  });

  it('never reaches a process when it was given up before it was made', async () => {
    const { executor, tool } = await start();
    const stop = new AbortController();
    stop.abort();
    expect(await tool('sleep', { ms: 600 }, undefined, stop.signal)).toMatchObject({
      ok: false,
      error: { name: 'AbortError' },
    });
    expect(executor.stats().processes[0]).toMatchObject({ abandoned: 0, inFlight: 0 });
  });

  it('is refused the secret it waits for', async () => {
    let asked = 0;
    const { executor, tool } = await start({
      secrets: async () => {
        asked += 1;
        await new Promise((resolve) => setTimeout(resolve, 300));
        return 'late';
      },
    });
    const stop = new AbortController();
    const waiting = tool('secret', { name: 'SLOW' }, undefined, stop.signal);
    await waitFor(() => asked === 1);
    stop.abort();
    expect(await waiting).toMatchObject({ ok: false, error: { name: 'AbortError' } });
    // Its code is told the call was stopped, and ends: nothing is left running.
    await waitFor(() => executor.stats().processes[0]?.abandoned === 0);
    expect(asked).toBe(1);
  });
});

describe('a process', () => {
  it('that stops answering is killed, and its calls are lost; the next call finds another', async () => {
    const { executor, deployment, load, tool } = await start({ probeMs: 100, stallMs: 1000 });
    const spinning = await load('// another deployment');
    expect(text(await tool('echo', { text: 'before' }))).toBe('before');
    const [before] = executor.stats().processes;

    const started = Date.now();
    const waiting = tool('sleep', { ms: 10_000 });
    const spin = tool('spin', {}, spinning);
    expect(await spin).toMatchObject({ ok: false, kind: 'lost' });
    expect(await waiting).toMatchObject({
      ok: false,
      kind: 'lost',
      reason: expect.stringMatching(/sent nothing for 1000 ms/) as string,
    });
    expect(Date.now() - started).toBeLessThan(2500);

    // The new process is sent the code again, without anyone asking.
    expect(text(await tool('echo', { text: 'after' }, deployment))).toBe('after');
    const [after] = executor.stats().processes;
    expect(after?.pid).not.toBe(before?.pid);
    expect(after).toMatchObject({ restarts: 1, kills: { stall: 1 } });
    expect(executor.stats().lost.stall).toBe(2);
  });

  it('that dies loses its calls, and another is started', async () => {
    const { executor, tool } = await start();
    const waiting = tool('sleep', { ms: 10_000 });
    await waitFor(() => executor.stats().processes[0]?.inFlight === 1);
    process.kill(executor.stats().processes[0]?.pid ?? 0, 'SIGKILL');
    expect(await waiting).toMatchObject({
      ok: false,
      kind: 'lost',
      reason: expect.stringMatching(/workerd exited with SIGKILL/) as string,
    });
    expect(text(await tool('echo', { text: 'after' }))).toBe('after');
    expect(executor.stats().processes[0]?.restarts).toBe(1);
  });

  it('whose connection drops loses its calls, and another is started', async () => {
    const { executor, tool } = await start();
    const waiting = tool('sleep', { ms: 10_000 });
    await waitFor(() => executor.stats().processes[0]?.inFlight === 1);
    sandboxesOf(executor.pool)[0]?.disconnect();
    expect(await waiting).toMatchObject({
      ok: false,
      kind: 'lost',
      reason: expect.stringMatching(/connection to workerd closed/) as string,
    });
    expect(text(await tool('echo', { text: 'after' }))).toBe('after');
  });

  it('is replaced before it holds more code than it may, and lets its calls finish first', async () => {
    const { executor, load, tool } = await start({ maxBundles: 2, drainMs: 5000 });
    const [second, third] = [await load('// two'), await load('// three')];
    await tool('echo', { text: 'one' });
    const [first] = executor.stats().processes;
    const slow = tool('sleep', { ms: 500 }, second);
    await waitFor(() => executor.stats().processes[0]?.inFlight === 1);
    await tool('echo', { text: 'three' }, third);

    // Those that run agents: the one that code is looked at in is another.
    const running = () => executor.stats().processes.filter((one) => one.slot >= 0);
    const during = running();
    expect(during.map((one) => one.state).toSorted()).toEqual(['draining', 'live']);
    expect(during.find((one) => one.state === 'draining')?.pid).toBe(first?.pid);
    expect(text(await slow)).toBe('slept');

    await waitFor(() => running().length === 1);
    const [live] = running();
    expect(live).toMatchObject({ bundles: 1, restarts: 1, state: 'live' });
    expect(live?.pid).not.toBe(first?.pid);
  });

  it('ends code that waits on nothing, which is a failure of the call and of nothing else', async () => {
    const { tool } = await start();
    expect(await tool('hang')).toMatchObject({
      ok: false,
      kind: 'error',
      error: { name: 'CallFailed' },
    });
    expect(text(await tool('echo', { text: 'after' }))).toBe('after');
  });

  it('dies with the engine, even one that is killed with no warning', async () => {
    const index = fileURLToPath(new URL('../src/index.ts', import.meta.url));
    const engine = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { IsolateExecutor } from ${JSON.stringify(index)};
         const executor = await IsolateExecutor.start({ processes: 2, log() {} });
         console.log(JSON.stringify(executor.stats().processes.map((one) => one.pid)));
         setInterval(() => {}, 1000);`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const pids = await new Promise<number[]>((resolve, reject) => {
      engine.stdout.setEncoding('utf8');
      engine.stdout.once('data', (line: string) => {
        resolve(JSON.parse(line) as number[]);
      });
      engine.once('exit', () => {
        reject(new Error('the engine exited'));
      });
    });
    expect(pids).toHaveLength(2);
    expect(pids.every(alive)).toBe(true);
    engine.kill('SIGKILL');
    await waitFor(() => !pids.some(alive));
  }, 20_000);

  it('leaves none behind when the executor is closed', async () => {
    const executor = await IsolateExecutor.start({ processes: 2, log: () => {} });
    const pids = executor.stats().processes.map((one) => one.pid);
    expect(pids).toHaveLength(2);
    await executor.close();
    await waitFor(() => !pids.some(alive));
    expect(executor.stats().processes).toEqual([]);
  });
});

describe('many deployments, and replacing a process', () => {
  const running = (executor: IsolateExecutor) =>
    executor.stats().processes.filter((one) => one.slot >= 0);

  it('replaces a process that has more calls given up, and still running, than it may', async () => {
    const { executor, tool } = await start({ maxAbandoned: 2 });
    await tool('echo', { text: 'loaded' });
    const [before] = running(executor);
    const stop = new AbortController();
    const sleeps = Array.from({ length: 3 }, () =>
      tool('sleep', { ms: 5000 }, undefined, stop.signal),
    );
    await waitFor(() => running(executor)[0]?.inFlight === 3);
    stop.abort();
    await Promise.all(sleeps);
    expect(running(executor)[0]?.abandoned).toBe(3);

    expect(text(await tool('echo', { text: 'after' }))).toBe('after');
    // Nothing waited for the old process's calls: it was killed at once.
    const after = running(executor);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ abandoned: 0, restarts: 1 });
    expect(after[0]?.pid).not.toBe(before?.pid);
    expect(alive(before?.pid ?? 0)).toBe(false);
  });

  it('keeps a process that is busy loading the code of 40 deployments at once', async () => {
    // A second of silence is what one load may take on a computer that is busy with other tests.
    const { executor, load, tool } = await start({ probeMs: 100, stallMs: 1000 });
    const deployments = await Promise.all(
      Array.from({ length: 40 }, (_, index) => load(`// burst ${String(index)}`)),
    );
    const answers = await Promise.all(
      deployments.map((deployment) => tool('echo', { text: 'hello' }, deployment)),
    );
    expect(answers.map(text)).toEqual(Array.from({ length: 40 }, () => 'hello'));
    const [one] = running(executor);
    expect(one).toMatchObject({ bundles: 40, restarts: 0, loading: 0, queuedLoads: 0 });
    // All of the loading takes longer than a process may be silent for. It was not taken for
    // stuck: each load that ends is a sign of life.
    expect(one?.kills.stall).toBe(0);
  }, 30_000);

  it('replaces a process again and again under steady calls without losing one', async () => {
    const { executor, load, tool } = await start({ maxBundles: 3, minRecycleMs: 0, drainMs: 5000 });
    const deployments = await Promise.all(
      Array.from({ length: 6 }, (_, index) => load(`// steady ${String(index)}`)),
    );
    const until = Date.now() + 1500;
    const worker = async (offset: number): Promise<number> => {
      let done = 0;
      for (let n = offset; Date.now() < until; n += 1) {
        const answer = await tool('sleep', { ms: 50 }, deployments[n % 6]);
        expect(text(answer)).toBe('slept');
        done += 1;
      }
      return done;
    };
    const counts = await Promise.all([0, 2, 4].map(worker));
    expect(counts.every((count) => count > 5)).toBe(true);
    const stats = executor.stats();
    expect(running(executor)[0]?.recycles.bundles).toBeGreaterThan(1);
    expect(Object.values(stats.lost).every((count) => count === 0)).toBe(true);
  });

  it('puts replacing off when it would be too often, and says it has too little room', async () => {
    const { executor, load, tool } = await start({ maxBundles: 2, minRecycleMs: 60_000 });
    for (let n = 1; n <= 5; n += 1) {
      const deployment = await load(`// backoff ${String(n)}`);
      expect(text(await tool('echo', { text: 'hello' }, deployment))).toBe('hello');
    }
    const stats = executor.stats();
    const [one] = running(executor).filter((process) => process.state === 'live');
    // Replaced once, at the third. After that it went over its count, not round again.
    expect(one?.recycles.bundles).toBe(1);
    expect(one?.deferredRecycles).toBeGreaterThan(0);
    expect(stats.capacity.ok).toBe(false);
    expect(stats.capacity.problems[0]).toMatch(/slot 0 wanted to recycle for bundles/);
  });

  it('spreads deployments over its processes, and keeps each where it went', async () => {
    const { executor, load, tool } = await start({ processes: 2 });
    const deployments = await Promise.all(
      Array.from({ length: 4 }, (_, index) => load(`// spread ${String(index)}`)),
    );
    for (let round = 0; round < 2; round += 1) {
      for (const deployment of deployments) {
        expect(text(await tool('echo', { text: 'hello' }, deployment))).toBe('hello');
      }
    }
    expect(running(executor).map((one) => one.bundles)).toEqual([2, 2]);
  });
});
