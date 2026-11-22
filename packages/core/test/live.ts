// One real turn through the whole engine for each provider: a message, a call of a tool, and
// an answer, on a store in memory. It makes real calls, so it is run by hand:
//
//   OPENAI_API_KEY=… FIREWORKS_API_KEY=… ANTHROPIC_API_KEY=… node packages/core/test/live.ts
//
// A provider whose key is not given is left out. ChatGPT is not here: it takes the token of
// someone signed in, which only signing in gives.

import { builtInProviders } from '@acentric/ai';
import { makeId } from '@acentric/protocol';
import type { AgentDefinition, DeploymentId, Json } from '@acentric/protocol';

import { Engine, MemoryStore, providerRunners } from '../src/index.ts';
import { InlineExecutor } from '../src/testing.ts';
import type { InlineAgent } from '../src/testing.ts';

const TARGETS = [
  { provider: 'openai', env: 'OPENAI_API_KEY', model: 'gpt-6-luna' },
  {
    provider: 'fireworks',
    env: 'FIREWORKS_API_KEY',
    model: 'accounts/fireworks/models/glm-5p3-flash',
  },
  { provider: 'anthropic', env: 'ANTHROPIC_API_KEY', model: 'claude-haiku-5-5' },
].filter((target) => process.env[target.env] !== undefined);

const random = () => crypto.getRandomValues(new Uint8Array(10));
const agent = makeId('agent', { now: Date.now(), random: random() });
const providers = builtInProviders();

const agents = new Map<DeploymentId, InlineAgent>();
const deployments = TARGETS.map((target) => {
  const definition: AgentDefinition = {
    provider: target.provider,
    instructions:
      'You answer questions about orders. Look an order up before you say anything of it. Be brief.',
    configuration: null,
    tools: [
      {
        name: 'lookup_order',
        description: 'Finds an order by its number, and says what happened to it.',
        parameters: {
          type: 'object',
          properties: { id: { type: 'integer', description: 'The number of the order.' } },
          required: ['id'],
          additionalProperties: false,
        },
        retrySafe: true,
      },
    ],
    inputs: [{ type: 'message', schema: null }],
  };
  const id = makeId('deployment', { now: Date.now(), random: random() });
  agents.set(id, {
    definition,
    functions: {
      'inputs.message.handler': (payload: Json) => (payload as { text: string }).text,
      'tools.lookup_order.execute': (asked: Json) =>
        `Order ${String((asked as { id: number }).id)} was refunded twice, one second apart.`,
    },
  });
  return { ...target, deployment: { id, version: 1 } };
});

const store = new MemoryStore();
const engine = new Engine({
  store,
  executor: new InlineExecutor(agents),
  runner: providerRunners(providers, (provider) => {
    const target = TARGETS.find((one) => one.provider === provider);
    const key = target === undefined ? undefined : process.env[target.env];
    return key === undefined ? undefined : { type: 'api_key', apiKey: key };
  }),
});

let failed = false;
for (const target of deployments) {
  const { actor } = await engine.createActor({
    agent,
    deployment: target.deployment,
    modelId: target.model,
    reasoning: 'low',
  });
  const started = Date.now();
  await engine.send(actor.id, {
    type: 'message',
    payload: { text: 'What happened to order 4411?' },
  });
  await engine.settled(actor.id);

  const record = await store.loadActor(actor.id);
  const conversation = await store.conversation(actor.id);
  const roles = conversation.map((entry) => entry.message.role).join(', ');
  const last = conversation.at(-1)?.message;
  const said = last?.role === 'assistant' ? providers.get(target.provider).read(last).text : '';
  const dollars = conversation.reduce(
    (all, entry) => all + (entry.completion?.usage?.cost?.total ?? 0),
    0,
  );
  const ok =
    record?.actor.lastTurn?.end === 'ok' &&
    roles === 'user, assistant, tool_result, assistant' &&
    /refunded/i.test(said);
  failed ||= !ok;
  const label = providers.get(target.provider).label;
  const took = String(Date.now() - started);
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${label} (${target.model}), ${took} ms, ${dollars.toFixed(6)} dollars`,
  );
  console.log(`     ${roles}`);
  console.log(`     turn: ${JSON.stringify(record?.actor.lastTurn)}`);
  console.log(`     says: ${JSON.stringify(said.slice(0, 160))}`);
}
await engine.close();
process.exit(failed ? 1 : 0);
