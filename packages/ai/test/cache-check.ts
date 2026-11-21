// Whether a provider keeps what it has read: the same long instructions are sent twice, a
// moment apart, and the second call says how much of them it did not read again. It makes
// real calls, so it is run by hand:
//
//   OPENAI_API_KEY=… FIREWORKS_API_KEY=… ANTHROPIC_API_KEY=… node packages/ai/test/cache-check.ts

import { builtInProviders } from '../src/index.ts';
import type { ModelStep } from '../src/index.ts';

const TARGETS = [
  { provider: 'openai', env: 'OPENAI_API_KEY', model: 'gpt-6-luna' },
  {
    provider: 'fireworks',
    env: 'FIREWORKS_API_KEY',
    model: 'accounts/fireworks/models/glm-5p3-flash',
  },
  { provider: 'anthropic', env: 'ANTHROPIC_API_KEY', model: 'claude-haiku-5-5' },
].filter((target) => process.env[target.env] !== undefined);

// Long enough that every provider keeps it, and different in each run, so that nothing kept
// from an earlier run is read in this one.
const run = String(Date.now());
const rules = Array.from(
  { length: 400 },
  (_, index) =>
    `Rule ${String(index + 1)} of run ${run}: an order numbered ${String(index + 1000)} is never refunded twice.`,
).join('\n');

const providers = builtInProviders();
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

for (const target of TARGETS) {
  const provider = providers.get(target.provider);
  const key = process.env[target.env] as string;
  const runner = provider.runner({ credential: { type: 'api_key', apiKey: key } });
  const step = (text: string): ModelStep => ({
    model: target.model,
    reasoning: 'low',
    instructions: `You answer in one word.\n${rules}`,
    tools: [],
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    session: `cache-check-${run}`,
  });
  const first = await runner.run(step('Say: one'), new AbortController().signal);
  await pause(3000);
  const second = await runner.run(step('Say: two'), new AbortController().signal);
  const show = (usage: typeof first.usage) =>
    `read ${String(usage?.totalInput)} tokens, ${String(usage?.cacheRead)} of them kept, ${String(usage?.cacheWrite ?? 'no count of')} written`;
  console.log(provider.label);
  console.log(`  first:  ${show(first.usage)}`);
  console.log(`  second: ${show(second.usage)}`);
}
