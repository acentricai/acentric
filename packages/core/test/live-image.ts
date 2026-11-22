// One real turn with an image through the whole engine for each provider, with a blob store:
// the agent's code gives a picture, the conversation keeps only its name, and the model is
// sent its bytes and asked what colour it is. It makes real calls, so it is run by hand:
//
//   OPENAI_API_KEY=… ANTHROPIC_API_KEY=… node packages/core/test/live-image.ts

import { crc32, deflateSync } from 'node:zlib';

import { builtInProviders } from '@acentric/ai';
import type { AgentDefinition } from '@acentric/protocol';

import { Engine, MemoryBlobStore, MemoryStore, providerRunners } from '../src/index.ts';
import { InlineExecutor } from '../src/testing.ts';

const TARGETS = [
  { provider: 'openai', env: 'OPENAI_API_KEY', model: 'gpt-6-luna' },
  { provider: 'anthropic', env: 'ANTHROPIC_API_KEY', model: 'claude-haiku-5-5' },
].filter((target) => process.env[target.env] !== undefined);

/** A PNG of one colour, 64 pixels a side. */
function png(red: number, green: number, blue: number): Buffer {
  const side = 64;
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  // Eight bits a channel, RGB.
  header.set([8, 2, 0, 0, 0], 8);
  const line = Buffer.concat([
    Buffer.from([0]),
    Buffer.alloc(side * 3, Buffer.from([red, green, blue])),
  ]);
  const pixels = Buffer.concat(Array.from({ length: side }, () => line));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const picture = png(220, 20, 30).toString('base64');
const providers = builtInProviders();
const definitionOf = (provider: string): AgentDefinition => ({
  provider,
  instructions: 'You answer in one word.',
  configuration: null,
  tools: [],
  inputs: [{ type: 'message', schema: null }],
});

const store = new MemoryStore();
const blobs = new MemoryBlobStore();
const engine = new Engine({
  store,
  blobs,
  providers,
  executor: new InlineExecutor(
    Object.fromEntries(
      TARGETS.map(({ provider }) => [
        provider,
        {
          definition: definitionOf(provider),
          functions: {
            'inputs.message.handler': () => [
              { type: 'text', text: 'What colour is this picture? One word.' },
              { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: picture } },
            ],
          },
        },
      ]),
    ),
  ),
  runner: providerRunners(providers, (provider) => {
    const target = TARGETS.find((one) => one.provider === provider);
    const key = target === undefined ? undefined : process.env[target.env];
    return key === undefined ? undefined : { type: 'api_key', apiKey: key };
  }),
});

let failed = false;
for (const target of TARGETS) {
  const { agent } = await engine.deploy({
    agent: `colours-${target.provider}`,
    manifest: { protocol: 1, sdk: '0.15.0' },
    code: target.provider,
  });
  const { actor } = await engine.createActor({ agent: agent.id, modelId: target.model });
  // Twice: the second call sends the picture again, read from the blob store again.
  for (let turn = 0; turn < 2; turn += 1) {
    await engine.send(actor.id, { type: 'message', payload: {} });
    await engine.settled(actor.id);
  }
  const record = await store.loadActor(actor.id);
  const conversation = await store.conversation(actor.id);
  const provider = providers.get(target.provider);
  const said = conversation
    .flatMap(({ message }) => (message.role === 'assistant' ? [provider.read(message).text] : []))
    .join(' / ');
  const inline = JSON.stringify(conversation).includes(picture);
  const kept = await blobs.list();
  const ok =
    record?.actor.lastTurn?.end === 'ok' &&
    !inline &&
    kept.length === 1 &&
    said.split(' / ').every((answer) => /red/i.test(answer));
  failed ||= !ok;
  console.log(
    `${ok ? 'ok    ' : 'FAILED'} ${target.provider} ${target.model}: said "${said}", ${String(kept.length)} blob kept, bytes ${inline ? 'IN' : 'not in'} the conversation${
      record?.actor.lastTurn?.end === 'ok' ? '' : `, turn ${JSON.stringify(record?.actor.lastTurn)}`
    }`,
  );
}
await engine.close();
if (TARGETS.length === 0) console.log('No key was given: nothing was called.');
process.exit(failed ? 1 : 0);
