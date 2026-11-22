// Two real turns through the whole engine for each provider, on a store in memory: a message,
// a call of a tool and an answer, then the agent is upgraded, and a second message is answered
// on the new version. It makes real calls, so it is run by hand:
//
//   OPENAI_API_KEY=… FIREWORKS_API_KEY=… ANTHROPIC_API_KEY=… node packages/core/test/live.ts
//
// A provider whose key is not given is left out. ChatGPT is not here: it takes the token of
// someone signed in, which only signing in gives.

import { bindsReasoning, builtInProviders } from '@acentric/ai';
import type { AgentDefinition, Json } from '@acentric/protocol';

import { Engine, MemoryStore, providerRunners } from '../src/index.ts';
import { InlineExecutor } from '../src/testing.ts';
import type { InlineAgent } from '../src/testing.ts';

// One model of each provider whose reasoning is tied to what came before it, where it has
// one: the second turn is on an upgraded agent, which such a model refuses unless the engine
// leaves the old reasoning out.
const TARGETS = [
  { provider: 'openai', env: 'OPENAI_API_KEY', model: 'gpt-6.2-sol' },
  {
    provider: 'fireworks',
    env: 'FIREWORKS_API_KEY',
    model: 'accounts/fireworks/models/glm-5p3-flash',
  },
  { provider: 'anthropic', env: 'ANTHROPIC_API_KEY', model: 'claude-fable-5-2' },
].filter((target) => process.env[target.env] !== undefined);

const providers = builtInProviders();
const MANIFEST = { protocol: 1, sdk: '0.15.0' };

/** The agent of a provider, as first deployed and as upgraded: other instructions, another tool. */
function agentOf(provider: string, upgraded: boolean): InlineAgent {
  const definition: AgentDefinition = {
    provider,
    instructions: upgraded
      ? 'You are a careful support agent for a shop. Look an order up before you say anything of it. Be brief and kind.'
      : 'You answer questions about orders. Look an order up before you say anything of it. Be brief.',
    configuration: null,
    tools: [
      {
        name: 'lookup_order',
        description: upgraded
          ? 'Finds an order by its number and reports what happened to it.'
          : 'Finds an order by its number, and says what happened to it.',
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
  return {
    definition,
    functions: {
      'inputs.message.handler': (payload: Json) => (payload as { text: string }).text,
      'tools.lookup_order.execute': (asked: Json) =>
        `Order ${String((asked as { id: number }).id)} was refunded twice, one second apart.`,
    },
  };
}

const store = new MemoryStore();
const engine = new Engine({
  store,
  executor: new InlineExecutor(
    Object.fromEntries(
      TARGETS.flatMap(({ provider }) => [
        [`${provider}@1`, agentOf(provider, false)],
        [`${provider}@2`, agentOf(provider, true)],
      ]),
    ),
  ),
  providers,
  runner: providerRunners(providers, (provider) => {
    const target = TARGETS.find((one) => one.provider === provider);
    const key = target === undefined ? undefined : process.env[target.env];
    return key === undefined ? undefined : { type: 'api_key', apiKey: key };
  }),
});

let failed = false;
for (const target of TARGETS) {
  const name = `orders-${target.provider}`;
  const { agent } = await engine.deploy({
    agent: name,
    manifest: MANIFEST,
    code: `${target.provider}@1`,
  });
  const { actor } = await engine.createActor({
    agent: agent.id,
    modelId: target.model,
    reasoning: 'high',
  });
  const started = Date.now();
  await engine.send(actor.id, {
    type: 'message',
    payload: {
      text: 'A customer says order 4411 was refunded twice. First think through the three most likely ways a shop ends up refunding one order twice, then look the order up and say which of them most likely happened here.',
    },
  });
  await engine.settled(actor.id);
  const first = await store.conversation(actor.id);

  // The agent is upgraded while the conversation is under way, and the actor follows.
  await engine.deploy({ agent: name, manifest: MANIFEST, code: `${target.provider}@2` });
  await engine.send(actor.id, {
    type: 'message',
    payload: { text: 'Was that a mistake on our side? One sentence.' },
  });
  await engine.settled(actor.id);

  const record = await store.loadActor(actor.id);
  const conversation = await store.conversation(actor.id);
  const roles = conversation.map((entry) => entry.message.role).join(', ');
  const last = conversation.at(-1)?.message;
  const provider = providers.get(target.provider);
  const said = last?.role === 'assistant' ? provider.read(last).text : '';
  const reasoned = first.some(
    ({ message }) => message.role === 'assistant' && provider.withoutReasoning(message) !== message,
  );
  const dollars = conversation.reduce(
    (all, entry) => all + (entry.completion?.usage?.cost?.total ?? 0),
    0,
  );
  const binds = bindsReasoning(provider, target.model);
  const ok =
    record?.actor.lastTurn?.end === 'ok' &&
    record.actor.deployment.version === 2 &&
    /^user, assistant, tool_result, assistant(, tool_result, assistant)*, user, assistant$/.test(
      roles,
    ) &&
    // Its old reasoning is left out exactly when its model ties reasoning to what came before.
    record.reasoningFrom > 1 === binds;
  failed ||= !ok;
  const took = String(Date.now() - started);
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${provider.label} (${target.model}), ${took} ms, ${dollars.toFixed(6)} dollars`,
  );
  console.log(`     ${roles}`);
  console.log(`     turn: ${JSON.stringify(record?.actor.lastTurn)}`);
  console.log(
    `     version ${String(record?.actor.deployment.version)}, reasoned before the upgrade: ${String(reasoned)}, reasoning sent from message ${String(record?.reasoningFrom)}`,
  );
  console.log(`     says: ${JSON.stringify(said.slice(0, 160))}`);
}
await engine.close();
process.exit(failed ? 1 : 0);
