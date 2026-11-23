// A server to measure under load: this repository's, started as its program starts it, from the
// same settings, with real HTTP, SQLite, workerd and blobs. Only the model is a stand-in, in the
// process: it answers after LOAD_MODEL_MS (a fifth either way), first with a call of the agent's
// tool and then with a few hundred tokens of text, and says what it used. So what is measured is
// the server, and a model as slow as a real one is waited for as one is.
//
//   ACENTRIC_ADMIN_KEY=… ACENTRIC_METRICS_PORT=9464 LOAD_MODEL_MS=2000 \
//     node apps/server/bench/load-server.ts
//
// Then `bench/load.ts`, from another machine, sends it the load. Built first: `pnpm build`.

import { Providers } from '@acentric/ai';
import type { ModelRunner } from '@acentric/ai';
import { calls, fakeProvider, says } from '@acentric/ai/testing';

import { readSettings, start } from '../src/index.ts';
import { createLogger } from '../src/log.ts';
import { LOAD_MODEL_KEY } from './load-shared.ts';

const delay = Number(process.env['LOAD_MODEL_MS'] ?? '0');
/** About 300 tokens: an answer as long as a model's often is. */
const ANSWER =
  `${'The order was refunded twice, a second apart, by the payments service retrying a call that had in fact gone through. '.repeat(12)}`.trim();

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms * (0.8 + Math.random() * 0.4)));

const model: ModelRunner = {
  async run(step) {
    if (delay > 0) await wait(delay);
    const asked = step.messages.findLastIndex((message) => message.role === 'user');
    const answered = step.messages
      .slice(asked + 1)
      .some((message) => message.role === 'tool_result');
    // A cheap reckoning of what it was sent: what it costs to count is not the server's.
    const input = step.messages.length * 400;
    // The agent's tool once, then the answer; and a summary, when the engine compacts the
    // conversation (it asks with no tool of the agent's).
    const ofAgent = step.tools.some((tool) => tool.name === 'lookup_order');
    const answer =
      answered || !ofAgent
        ? says(ANSWER)
        : calls({ id: `call-${String(Date.now())}`, name: 'lookup_order', arguments: { id: 42 } });
    // What it used: a token to four characters, as near as anyone reckons.
    return {
      ...answer,
      usage: {
        totalInput: Math.ceil(input / 4),
        input: Math.ceil(input / 4),
        output: answered ? Math.ceil(ANSWER.length / 4) : 20,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        webSearches: 0,
      },
    };
  },
};

const settings = readSettings(process.env);
const logger = createLogger(settings.log);
const server = await start(settings, {
  version: 'load',
  providers: new Providers([fakeProvider(model, { keys: [LOAD_MODEL_KEY] })]),
  logger,
});
logger.info(
  `load server listening on ${server.server.url}, the model answering in ${String(delay)}ms`,
);
if (server.metricsUrl !== undefined) logger.info(`metrics at ${server.metricsUrl}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close({ graceMs: 1000 }).then(() => process.exit(0));
  });
}
