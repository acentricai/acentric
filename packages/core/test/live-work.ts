// Real turns through the whole engine for each provider, on a store in memory, of what an
// actor does besides answering: it runs a script that calls its agent's tools and an MCP
// server's, spawns a subagent and hears back from it, sends itself a note, and has its
// conversation compacted and goes on after. It makes real calls, so it is run by hand:
//
//   OPENAI_API_KEY=… FIREWORKS_API_KEY=… ANTHROPIC_API_KEY=… node packages/core/test/live-work.ts
//
// A provider whose key is not given is left out. The MCP server is one of the tests' own, in
// this process.

import { builtInProviders } from '@acentric/ai';
import type { ActorId, AgentDefinition, Json } from '@acentric/protocol';

import { Engine, MemoryStore, providerRunners } from '../src/index.ts';
import { InlineExecutor } from '../src/testing.ts';
import type { InlineAgent } from '../src/testing.ts';
import { THINGS_URL, mcpServers } from './mcp-server.ts';

const TARGETS = [
  { provider: 'openai', env: 'OPENAI_API_KEY', model: 'gpt-6.2-sol', compacts: 'all' },
  {
    provider: 'fireworks',
    env: 'FIREWORKS_API_KEY',
    model: 'accounts/fireworks/models/glm-5p3-flash',
    compacts: 'summary',
  },
  { provider: 'anthropic', env: 'ANTHROPIC_API_KEY', model: 'claude-fable-5-2', compacts: 'older' },
].filter((target) => process.env[target.env] !== undefined);

const providers = builtInProviders();
const servers = mcpServers();
const MANIFEST = { protocol: 1, sdk: '0.15.0' };
/** Every order that was looked up, in order. */
const lookedUp: number[] = [];

const base = (provider: string, instructions: string): AgentDefinition => ({
  provider,
  instructions,
  configuration: null,
  tools: [],
  inputs: [{ type: 'message', schema: null }],
});

function leadOf(provider: string, model: string): InlineAgent {
  return {
    definition: {
      ...base(
        provider,
        'You run a small shop’s back office. Do what you are asked with the tools you have, and be brief.',
      ),
      tools: [
        {
          name: 'lookup_order',
          description: 'Finds an order by its number. Answers JSON, with its total.',
          parameters: {
            type: 'object',
            properties: { id: { type: 'integer', description: 'The number of the order.' } },
            required: ['id'],
            additionalProperties: false,
          },
          retrySafe: true,
          codemode: true,
        },
      ],
      mcps: [{ name: 'things', url: THINGS_URL, description: 'The warehouse: what is in stock.' }],
      subagents: [
        {
          agent: `helper-${provider}`,
          description: 'Answers a question of arithmetic.',
          creates: false,
        },
      ],
      // Little is kept as it is, so that there is an older part to compact.
      compactionSettings: { [model]: { reserve: 600 } },
      features: ['codemode', 'mcps', 'subagents', 'compaction-settings'],
    },
    functions: {
      'inputs.message.handler': (payload: Json) => (payload as { text: string }).text,
      'tools.lookup_order.execute': (asked: Json) => {
        const { id } = asked as { id: number };
        lookedUp.push(id);
        return JSON.stringify({ id, lines: 2, total: id - 4400 });
      },
      'mcps.things.headers': () => ({ Authorization: 'Bearer key-123' }),
    },
  };
}

const helperOf = (provider: string): InlineAgent => ({
  definition: base(provider, 'You answer questions of arithmetic. Be brief.'),
  functions: { 'inputs.message.handler': (payload: Json) => (payload as { text: string }).text },
});

const store = new MemoryStore();
const engine = new Engine({
  store,
  executor: new InlineExecutor(
    Object.fromEntries(
      TARGETS.flatMap(({ provider, model }) => [
        [`lead-${provider}@1`, leadOf(provider, model)],
        [`helper-${provider}@1`, helperOf(provider)],
      ]),
    ),
  ),
  providers,
  runner: providerRunners(providers, (provider) => {
    const target = TARGETS.find((one) => one.provider === provider);
    const key = target === undefined ? undefined : process.env[target.env];
    return key === undefined ? undefined : { type: 'api_key', apiKey: key };
  }),
  mcp: { fetch: servers.fetch },
});

/** Until no actor has a turn going on or mail that starts one, and `done` holds. */
async function quiet(done: () => Promise<boolean>, ms = 240_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await engine.settled();
    if ((await store.unfinished()).length === 0 && (await done())) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

let failed = false;
for (const target of TARGETS) {
  const provider = providers.get(target.provider);
  const started = Date.now();
  const checks: [string, boolean][] = [];
  let actorId: ActorId | undefined;
  const textOf = async (): Promise<string> => {
    const conversation = actorId === undefined ? [] : await store.conversation(actorId);
    const last = conversation.findLast((entry) => entry.message.role === 'assistant')?.message;
    return last?.role === 'assistant' ? provider.read(last).text : '';
  };
  try {
    const { agent } = await engine.deploy({
      agent: `lead-${target.provider}`,
      manifest: MANIFEST,
      code: `lead-${target.provider}@1`,
    });
    await engine.deploy({
      agent: `helper-${target.provider}`,
      manifest: MANIFEST,
      code: `helper-${target.provider}@1`,
    });
    const { actor } = await engine.createActor({
      agent: agent.id,
      modelId: target.model,
      reasoning: 'medium',
    });
    actorId = actor.id;
    const say = async (text: string) => {
      await engine.send(actor.id, { type: 'message', payload: { text } });
      await engine.settled(actor.id);
    };

    // A script, which calls the agent's own tool three times and finds a tool of the server.
    lookedUp.length = 0;
    servers.calls.length = 0;
    await say(
      'With one script: look up orders 4411, 4412 and 4413, and ask the warehouse server how many of the item "bolt" are left in stock. Tell me the sum of the three totals and the stock.',
    );
    const scripts = (await store.listTasks(actor.id)).filter((task) => task.kind === 'code');
    checks.push(
      ['a script ran to its end', scripts.some((task) => task.status === 'done')],
      ['it called the agent’s tool', [4411, 4412, 4413].every((id) => lookedUp.includes(id))],
      ['it called the MCP server’s tool', servers.calls.includes('stock:bolt')],
      ['the model says the sum, 36', (await textOf()).includes('36')],
    );

    // A subagent, which is asked something and answers by a message.
    await engine.send(actor.id, {
      type: 'message',
      payload: {
        text: 'Create a subagent named checker and ask it what 17 times 3 is. When its answer arrives, tell me the number.',
      },
    });
    const answered = await quiet(async () =>
      (await store.conversation(actor.id)).some(
        (entry) =>
          entry.message.role === 'system' &&
          JSON.stringify(entry.message.content).includes('<message from=\\"checker\\">'),
      ),
    );
    checks.push(
      ['a subagent was spawned', (await store.findChild(actor.id, 'checker')) !== undefined],
      ['it answered by a message', answered],
      ['the model says its answer, 51', (await textOf()).includes('51')],
    );

    // A note to its later self.
    await engine.send(actor.id, {
      type: 'message',
      payload: {
        text: 'Schedule a note to yourself for 3 seconds from now that says: say the word arrived. Then end your turn. When the note arrives, do what it says.',
      },
    });
    const fired = await quiet(async () =>
      (await store.listTasks(actor.id)).some(
        (task) => task.kind === 'schedule' && task.status === 'done',
      ),
    );
    await quiet(async () => true);
    checks.push(
      ['a schedule fired', fired],
      ['the model did what its note said', /arrived/i.test(await textOf())],
    );

    // The conversation is compacted, and goes on after.
    const { compacted } = await engine.compact(actor.id);
    await say('What was the sum of the three order totals I asked for at the start? One number.');
    const record = await store.loadActor(actor.id);
    const conversation = await store.conversation(actor.id);
    const kept = conversation.filter(
      (entry) => compacted !== null && entry.seq >= compacted.keepFromSeq,
    );
    const reasoning = kept.some(
      ({ message }) =>
        message.role === 'assistant' && provider.withoutReasoning(message) !== message,
    );
    checks.push(
      [
        `it was compacted as its provider does (${target.compacts})`,
        compacted?.kind === target.compacts,
      ],
      ['the turn after it ended well', record?.actor.lastTurn?.end === 'ok'],
      ['the model still knows the sum, 36', (await textOf()).includes('36')],
    );
    console.log(
      `     compaction: ${JSON.stringify(compacted)}; turns kept as they were hold reasoning: ${String(reasoning)}`,
    );
  } catch (error) {
    checks.push([`it failed: ${error instanceof Error ? error.message : String(error)}`, false]);
  }
  const ok = checks.every(([, held]) => held);
  failed ||= !ok;
  const dollars = (await engine.usage({})).totals.cost;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${provider.label} (${target.model}), ${String(Date.now() - started)} ms, ${JSON.stringify(dollars)} dollars so far`,
  );
  for (const [what, held] of checks) console.log(`     ${held ? 'yes' : 'NO '} ${what}`);
  if (!ok && actorId !== undefined) {
    const roles = (await store.conversation(actorId)).map((entry) => entry.message.role);
    console.log(`     ${roles.join(', ')}`);
    console.log(`     turn: ${JSON.stringify((await store.loadActor(actorId))?.actor.lastTurn)}`);
    console.log(`     says: ${JSON.stringify((await textOf()).slice(0, 300))}`);
  }
}
await engine.close();
process.exit(failed ? 1 : 0);
