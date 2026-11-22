// What the executor that keeps code apart costs: memory for each deployment it holds, how long
// a first and a later call take, how many calls it takes at once, and what code that loops
// does to the others of its process. It is heavy: it is for a server, not for a laptop.
//
//   pnpm bench:isolates [--deployments 100] [--calls 10000]
//
// The agent is the tests' own: about 780 KB of code, most of it a schema library.

import { performance } from 'node:perf_hooks';

import { NO_MACHINE } from '@acentric/core';
import type { CallContext } from '@acentric/core';
import { makeId } from '@acentric/protocol';
import type { DeploymentId } from '@acentric/protocol';

import { IsolateExecutor } from '../src/index.ts';
import { bundle } from '../test/bundle.ts';

const args = process.argv.slice(2);
const numberOf = (name: string, otherwise: number): number => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? otherwise : Number(args[at + 1]);
};
const DEPLOYMENTS = numberOf('deployments', 100);
const CALLS = numberOf('calls', 10_000);

let made = 0;
const id = <K extends 'agent' | 'actor' | 'deployment'>(kind: K) => {
  made += 1;
  const random = Uint8Array.from([0, 0, 0, 0, 0, 0, made >> 24, made >> 16, made >> 8, made]);
  return makeId(kind, { now: 1_795_305_600_000, random });
};
const agent = { id: id('agent'), name: 'bench' };
const context: CallContext = {
  agent: agent.id,
  actor: id('actor'),
  actorName: null,
  externalId: null,
  configuration: null,
  modelId: 'fake-1',
  reasoning: 'medium',
  machine: null,
};
const signal = () => new AbortController().signal;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const quantile = (values: readonly number[], q: number): number => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
};
const summary = (values: readonly number[]): string =>
  `median ${quantile(values, 0.5).toFixed(2)} ms, p95 ${quantile(values, 0.95).toFixed(2)} ms`;

const code = await bundle('sandboxed');
console.log(`The agent's code is ${String(Math.round(code.length / 1024))} KB.`);

const executor = await IsolateExecutor.start({ processes: 1, log: () => {}, maxRssMb: 8192 });
const echo = (deployment: DeploymentId) =>
  executor.call(deployment, 'tools.echo.execute', { text: 'hello' }, context, signal(), NO_MACHINE);
/** The memory of the process that runs agents, once the watchdog has read it afresh. */
const rss = async (): Promise<number> => {
  await sleep(2500);
  return executor.stats().processes.find((one) => one.slot === 0)?.rssMb ?? 0;
};

// Deploying: the code is loaded and asked what it is, in a process kept for that.
const deployments: DeploymentId[] = [];
const loads: number[] = [];
for (let index = 0; index < DEPLOYMENTS; index += 1) {
  const deployment = id('deployment');
  const started = performance.now();
  await executor.load(deployment, { code: `${code}\n// ${String(index)}`, agent });
  loads.push(performance.now() - started);
  deployments.push(deployment);
}
console.log(`Loading code and asking what it is: ${summary(loads)}.`);

// A first call of a deployment sends its code to the process and loads it there.
const empty = await rss();
const cold: number[] = [];
for (const deployment of deployments) {
  const started = performance.now();
  await echo(deployment);
  cold.push(performance.now() - started);
}
const full = await rss();
const each = (full - empty) / DEPLOYMENTS;
console.log(`A first call of a deployment: ${summary(cold)}.`);
console.log(
  `Memory: ${String(empty)} MB with none loaded, ${String(full)} MB with ${String(DEPLOYMENTS)}: ${each.toFixed(1)} MB for each.`,
);

const warm: number[] = [];
for (let index = 0; index < 1000; index += 1) {
  const started = performance.now();
  await echo(deployments[index % DEPLOYMENTS] as DeploymentId);
  warm.push(performance.now() - started);
}
console.log(`A later call: ${summary(warm)}.`);

const started = performance.now();
await Promise.all(
  Array.from({ length: CALLS }, (_, index) =>
    echo(deployments[index % DEPLOYMENTS] as DeploymentId),
  ),
);
const took = performance.now() - started;
console.log(
  `${String(CALLS)} calls at once: ${took.toFixed(0)} ms, ${String(Math.round((CALLS / took) * 1000))} a second.`,
);

// Code that never yields, and a call into another deployment of the same process.
const spinning = deployments[0] as DeploymentId;
const other = deployments[1] as DeploymentId;
const spun = performance.now();
const spin = executor.call(spinning, 'tools.spin.execute', {}, context, signal(), NO_MACHINE);
await sleep(50);
const waiting = await echo(other);
await spin;
const lost = performance.now() - spun;
const again = performance.now();
await echo(other);
console.log(
  `Code that loops: a call into another deployment ended as ${waiting.ok ? 'answered' : waiting.kind} after ${lost.toFixed(0)} ms, when the process was killed. The next call was answered ${(performance.now() - again).toFixed(0)} ms later.`,
);

await executor.close();
