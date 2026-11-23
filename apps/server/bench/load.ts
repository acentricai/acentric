// Load for a server: as many actors as each step says, each sent a message, its turn followed on
// its event stream to its end, then a pause, again and again; and the server's own metrics read
// at each step's end, for what the server did: turns, how long they took less the model's time,
// what waited, its CPU and memory, its event loop, and how its database grew.
//
//   node apps/server/bench/load.ts --url http://host:4000 --metrics http://host:9464/metrics \
//     --key <admin key> [--steps 10,25,50,100,200] [--step-seconds 60] [--think-ms 1000] \
//     [--extra-streams 0] [--out results.json]
//
// It is for a server started by `bench/load-server.ts`, whose model is a stand-in: it deploys
// the tests' orders agent there, with a model account and the agent's secret.

import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { createClient } from '@acentric/client';
import type { ActorId, AgentId } from '@acentric/protocol';

import { bundle } from '../../../packages/executor/test/bundle.ts';
import { LOAD_MODEL_KEY } from './load-shared.ts';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    metrics: { type: 'string' },
    key: { type: 'string' },
    steps: { type: 'string', default: '10,25,50,100,200' },
    'step-seconds': { type: 'string', default: '60' },
    'think-ms': { type: 'string', default: '1000' },
    'extra-streams': { type: 'string', default: '0' },
    out: { type: 'string' },
  },
});
const url = values.url ?? '';
const metricsUrl = values.metrics ?? '';
const key = values.key ?? '';
if (url === '' || metricsUrl === '' || key === '') {
  throw new Error('--url, --metrics and --key are needed');
}
const steps = values.steps.split(',').map(Number);
const stepMs = Number(values['step-seconds']) * 1000;
const thinkMs = Number(values['think-ms']);
const extraStreams = Number(values['extra-streams']);

const client = createClient({ baseUrl: url, token: key });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// The server's metrics, as numbers by name and labels.
type Sample = Map<string, number>;
async function sample(): Promise<Sample> {
  const text = await (await fetch(metricsUrl)).text();
  const found: Sample = new Map();
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || line === '') continue;
    const at = line.lastIndexOf(' ');
    found.set(line.slice(0, at), Number(line.slice(at + 1)));
  }
  return found;
}
const sum = (sampled: Sample, prefix: string): number =>
  [...sampled]
    .filter(([name]) => name.startsWith(prefix))
    .reduce((all, [, value]) => all + value, 0);
const value = (sampled: Sample, name: string): number => sampled.get(name) ?? 0;

/** An actor's event stream: tells each time its turn ends. */
function follow(actor: ActorId, ended: () => void, signal: AbortSignal): void {
  void (async () => {
    try {
      const answer = await fetch(`${url}/v1/actors/${actor}/events`, {
        headers: { authorization: `Bearer ${key}` },
        signal,
      });
      const reader = answer.body?.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      // The first status says where the actor stands as the stream opens: what ends after is new.
      let lastAt: number | undefined;
      for (;;) {
        const read = await reader?.read();
        if (read === undefined || read.done) return;
        buffer += read.value;
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          if (!frame.startsWith('event: status')) continue;
          const data = frame.split('\n').find((line) => line.startsWith('data: '));
          const status = JSON.parse(data?.slice(6) ?? '{}') as {
            status?: string;
            lastTurn?: { at: number } | null;
          };
          const at = status.lastTurn?.at ?? 0;
          if (lastAt === undefined) lastAt = at;
          else if (status.status === 'idle' && at > lastAt) {
            lastAt = at;
            ended();
          }
        }
      }
    } catch {
      // Given up, as the step ended.
    }
  })();
}

/** One actor's load: a message, its turn to its end, a pause; until `stop`. */
async function work(
  actor: ActorId,
  stop: AbortSignal,
  record: (ms: number, ok: boolean) => void,
): Promise<void> {
  let turnEnded: (() => void) | undefined;
  follow(actor, () => turnEnded?.(), stop);
  await sleep(500);
  while (!stop.aborted) {
    const began = performance.now();
    const done = new Promise<void>((resolve) => {
      turnEnded = resolve;
    });
    try {
      await client.call('inputs.send', {
        params: { actor },
        body: {
          type: 'message',
          payload: { text: 'What happened to order 42, and why was it refunded twice?' },
        },
      });
      await Promise.race([done, sleep(300_000)]);
      record(performance.now() - began, true);
    } catch {
      record(performance.now() - began, false);
      await sleep(1000);
    }
    await sleep(thinkMs * (0.5 + Math.random()));
  }
}

const quantile = (sorted: number[], q: number): number =>
  sorted.length === 0
    ? 0
    : (sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0);

// The agent, its model account and its secret.
const deployed = await client.call('deployments.create', {
  body: {
    agent: 'load-orders',
    manifest: { protocol: 1, sdk: '0.15.0' },
    code: await bundle('orders'),
  },
});
const agent = deployed.agent.id as AgentId;
await client
  .call('accounts.create', { body: { provider: 'fake', name: 'load', apiKey: LOAD_MODEL_KEY } })
  .catch(() => {});
await client.call('secrets.set', {
  params: { agent, name: 'ORDERS_API_KEY' },
  body: { value: 'a-key-for-the-load' },
});

const actors: ActorId[] = [];
const results: object[] = [];
let before = await sample();
console.log(
  'actors  turns/min  turn p50  p95 (client)  server ms/turn  waiting  running  cpu%  rss MB  loop p99 ms  db KB/turn  errors',
);
for (const count of steps) {
  // Made 25 at a time: from far away, one at a time takes long.
  while (actors.length < count) {
    const made = await Promise.all(
      Array.from({ length: Math.min(25, count - actors.length) }, () =>
        client.call('actors.create', { params: { agent }, body: { configuration: {} } }),
      ),
    );
    actors.push(...made.map(({ actor }) => actor.id));
  }
  const stop = new AbortController();
  const times: number[] = [];
  let errors = 0;
  const record = (ms: number, ok: boolean) => {
    if (ok) times.push(ms);
    else errors += 1;
  };
  const loops = actors.map((actor) => work(actor, stop.signal, record));
  for (let n = 0; n < extraStreams; n += 1) {
    follow(actors[n % actors.length] as ActorId, () => {}, stop.signal);
  }
  // What waited, and what ran, at their most in the step.
  let waiting = 0;
  let running = 0;
  const began = performance.now();
  while (performance.now() - began < stepMs) {
    await sleep(2000);
    const now = await sample();
    waiting = Math.max(waiting, value(now, 'acentric_turns_waiting'));
    running = Math.max(running, value(now, 'acentric_turns_running'));
  }
  stop.abort();
  await Promise.race([Promise.all(loops), sleep(10_000)]);
  const after = await sample();
  const seconds = (performance.now() - began) / 1000;

  const turns =
    sum(after, 'acentric_turns_ended_total') - sum(before, 'acentric_turns_ended_total');
  const turnSeconds =
    sum(after, 'acentric_turn_duration_seconds_sum') -
    sum(before, 'acentric_turn_duration_seconds_sum');
  const modelSeconds =
    sum(after, 'acentric_model_call_duration_seconds_sum') -
    sum(before, 'acentric_model_call_duration_seconds_sum');
  const cpu =
    value(after, 'acentric_process_cpu_seconds_total') -
    value(before, 'acentric_process_cpu_seconds_total');
  const db =
    value(after, 'acentric_database_bytes{file="database"}') +
    value(after, 'acentric_database_bytes{file="wal"}') -
    value(before, 'acentric_database_bytes{file="database"}') -
    value(before, 'acentric_database_bytes{file="wal"}');
  const sorted = times.toSorted((a, b) => a - b);
  const result = {
    actors: count,
    seconds: Math.round(seconds),
    turnsPerMinute: Math.round((turns / seconds) * 60),
    clientTurnMs: {
      p50: Math.round(quantile(sorted, 0.5)),
      p95: Math.round(quantile(sorted, 0.95)),
    },
    serverMsPerTurn: turns === 0 ? 0 : Math.round(((turnSeconds - modelSeconds) / turns) * 1000),
    waitingMost: waiting,
    runningMost: running,
    cpuPercent: Math.round((cpu / seconds) * 100),
    rssMb: Math.round(value(after, 'acentric_process_resident_memory_bytes') / 1_048_576),
    loopP99Ms: Math.round(
      value(after, 'acentric_event_loop_delay_seconds{quantile="0.99"}') * 1000,
    ),
    dbKbPerTurn: turns === 0 ? 0 : Math.round(db / turns / 1024),
    errors,
  };
  results.push(result);
  console.log(
    [
      String(result.actors).padStart(6),
      String(result.turnsPerMinute).padStart(10),
      String(result.clientTurnMs.p50).padStart(9),
      String(result.clientTurnMs.p95).padStart(13),
      String(result.serverMsPerTurn).padStart(15),
      String(result.waitingMost).padStart(8),
      String(result.runningMost).padStart(8),
      String(result.cpuPercent).padStart(5),
      String(result.rssMb).padStart(7),
      String(result.loopP99Ms).padStart(12),
      String(result.dbKbPerTurn).padStart(11),
      String(result.errors).padStart(7),
    ].join(' '),
  );
  before = after;
}
if (values.out !== undefined) writeFileSync(values.out, `${JSON.stringify(results, null, 2)}\n`);
process.exit(0);
