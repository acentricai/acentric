// createLlm: where a call goes, from the handler's secrets, and what happens
// on the way: a direct call, the gateway, failures, cancelling.

import { readFileSync } from 'node:fs';

import type { Agent, Handlers, JsonObject } from '@acentric/types';
import { createMemoryRunner } from '@acentric/runner-memory';
import { describe, expect, it } from 'vitest';

import {
  callProvider,
  createLlm,
  GATEWAY_ROUTE,
  LLM_VERSION,
  LlmError,
  llmFailure,
  llmSecrets,
  outputText,
  readCredentials,
  VERSION_HEADER,
} from '../src/client.js';
import type { GatewayRequest, LlmRequest, LlmResponse } from '../src/client.js';
import { anthropicBody, fakeFetch, responsesBody, secrets } from './fake.js';

const request: LlmRequest<'anthropic'> = {
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
    { role: 'custom', tag: 'ui', data: { pinned: true } },
  ],
};

const gatewaySecrets = {
  ACENTRIC_LLM_URL: 'https://llm.example.test/',
  ACENTRIC_LLM_TOKEN: 'tok_1',
};

/** A fetch for a network that is down. */
const down: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));

async function failure(promise: Promise<unknown>): Promise<LlmError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LlmError) return error;
    throw error;
  }
  throw new Error('it did not fail');
}

describe('createLlm', () => {
  it("calls the provider with its key when there is no gateway, leaving the application's messages out", async () => {
    const { fetch, sent } = fakeFetch(() => ({
      body: anthropicBody([{ type: 'text', text: 'Hello' }]),
    }));
    const llm = createLlm({ secrets: secrets({ ANTHROPIC_API_KEY: 'sk-ant' }) }, { fetch });
    const response = await llm.complete(request);
    expect(outputText(response.message)).toBe('Hello');
    expect(sent[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(sent[0]?.headers.get('x-api-key')).toBe('sk-ant');
    expect(sent[0]?.body['messages']).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
    ]);
  });

  it('calls the gateway with its token and the client version when the secrets name one', async () => {
    const { fetch, sent } = fakeFetch(() => ({ body: { provider: 'anthropic', message: {} } }));
    await createLlm({ secrets: secrets(gatewaySecrets) }, { fetch }).complete(request);
    expect(sent[0]?.url).toBe(`https://llm.example.test${GATEWAY_ROUTE}`);
    expect(sent[0]?.headers.get('authorization')).toBe('Bearer tok_1');
    expect(sent[0]?.headers.get(VERSION_HEADER)).toBe(LLM_VERSION);
    expect(sent[0]?.body).not.toHaveProperty('effect');
    expect(sent[0]?.body['messages']).toHaveLength(1);
  });

  it('sends the version in package.json', () => {
    const url = new URL('../package.json', import.meta.url);
    const { version }: { version: string } = JSON.parse(readFileSync(url, 'utf8'));
    expect(LLM_VERSION).toBe(version);
  });

  it('calls a provider with its own key even when the secrets name a gateway, and the gateway for the others', async () => {
    const { fetch, sent } = fakeFetch((call) =>
      call.url.startsWith('https://api.anthropic.com')
        ? { body: anthropicBody([]) }
        : { body: { provider: 'openai', message: {} } },
    );
    const llm = createLlm(
      { secrets: secrets({ ...gatewaySecrets, ANTHROPIC_API_KEY: 'sk-ant' }) },
      { fetch },
    );
    await llm.complete(request);
    await llm.complete({ provider: 'openai', model: 'gpt-6.1-sol', messages: [] });
    expect(sent.map((call) => call.url)).toEqual([
      'https://api.anthropic.com/v1/messages',
      `https://llm.example.test${GATEWAY_ROUTE}`,
    ]);
    expect(sent[0]?.headers.get('x-api-key')).toBe('sk-ant');
    expect(sent[1]?.headers.get('authorization')).toBe('Bearer tok_1');
    expect(sent[1]?.body).not.toHaveProperty('credentials');
  });

  it('sends the gateway the effect the call is made for, and never a provider', async () => {
    const { fetch, sent } = fakeFetch((call) =>
      call.url.startsWith('https://api.anthropic.com')
        ? { body: anthropicBody([]) }
        : { body: { provider: 'openai', message: {} } },
    );
    const effect = { key: 'llm:1', kind: 'llm', attempt: 2 };
    const llm = createLlm(
      { secrets: secrets({ ...gatewaySecrets, ANTHROPIC_API_KEY: 'sk-ant' }), ...effect },
      { fetch },
    );
    await llm.complete({ provider: 'openai', model: 'gpt-6.1-sol', messages: [] });
    await llm.complete(request);
    expect(sent[0]?.body['effect']).toEqual(effect);
    expect(sent[1]?.body).not.toHaveProperty('effect');
  });

  it('lets options choose: given credentials, another gateway, or none', async () => {
    const { fetch, sent } = fakeFetch((call) =>
      call.url.startsWith('https://api.anthropic.com')
        ? { body: anthropicBody([]) }
        : { body: { provider: 'anthropic', message: {} } },
    );
    const context = { secrets: secrets({ ...gatewaySecrets, ANTHROPIC_API_KEY: 'sk-ant' }) };
    await createLlm(context, { fetch, gateway: false }).complete(request);
    await createLlm(context, {
      fetch,
      gateway: { url: 'http://localhost:8787', token: 't' },
    }).complete(request);
    await createLlm(context, {
      fetch,
      gateway: { url: 'http://localhost:8787', token: 't' },
      credentials: { anthropic: { apiKey: 'other' } },
    }).complete(request);
    expect(sent.map((call) => call.url)).toEqual([
      'https://api.anthropic.com/v1/messages',
      `http://localhost:8787${GATEWAY_ROUTE}`,
      'https://api.anthropic.com/v1/messages',
    ]);
    expect(sent[2]?.headers.get('x-api-key')).toBe('other');
  });

  it('fails with auth, naming the secrets, when there is nothing to call with', async () => {
    const { fetch } = fakeFetch(() => ({ body: {} }));
    const none = await failure(createLlm({ secrets: secrets({}) }, { fetch }).complete(request));
    expect(none.toJSON()).toMatchObject({ kind: 'auth', provider: 'anthropic' });
    expect(none.message).toMatch(/ANTHROPIC_API_KEY/);
    const half = await failure(
      createLlm({ secrets: secrets({ ACENTRIC_LLM_URL: 'https://x' }) }, { fetch }).complete(
        request,
      ),
    );
    expect(half.message).toMatch(/ACENTRIC_LLM_URL is set but ACENTRIC_LLM_TOKEN is not/);
  });

  it('does not take another way when a secret cannot be read', async () => {
    const { fetch, sent } = fakeFetch(() => ({ body: {} }));
    const broken = { get: () => Promise.reject(new Error('the vault is down')) };
    await expect(createLlm({ secrets: broken }, { fetch }).complete(request)).rejects.toThrow(
      'the vault is down',
    );
    expect(sent).toEqual([]);
  });

  it("passes on the gateway's own failure", async () => {
    const gatewayError = new LlmError('slow down', {
      kind: 'rate_limited',
      provider: 'anthropic',
      retryAfterMs: 500,
    });
    const { fetch } = fakeFetch(() => ({ status: 429, body: { error: gatewayError.toJSON() } }));
    const error = await failure(
      createLlm({ secrets: secrets(gatewaySecrets) }, { fetch }).complete(request),
    );
    expect(error.toJSON()).toEqual(gatewayError.toJSON());
  });

  it("stops with cancelled when the handler's signal fires", async () => {
    const controller = new AbortController();
    const { fetch } = fakeFetch(
      () =>
        new Promise((resolve) => {
          controller.abort();
          setTimeout(() => resolve({ body: anthropicBody([]) }), 50);
        }),
    );
    const llm = createLlm(
      { secrets: secrets({ ANTHROPIC_API_KEY: 'k' }), signal: controller.signal },
      { fetch },
    );
    expect((await failure(llm.complete(request))).kind).toBe('cancelled');
  });

  it('fails with network_error when the provider cannot be reached, and timeout when it is too slow', async () => {
    const llm = createLlm({ secrets: secrets({ ANTHROPIC_API_KEY: 'k' }) }, { fetch: down });
    expect((await failure(llm.complete(request))).kind).toBe('network_error');
    const slow = fakeFetch(() => new Promise(() => undefined));
    const late = createLlm({ secrets: secrets({ ANTHROPIC_API_KEY: 'k' }) }, { fetch: slow.fetch });
    expect((await failure(late.complete({ ...request, timeoutMs: 20 }))).kind).toBe('timeout');
  });
});

/**
 * A gateway as acentric-cloud would run it: read the body, keep the effect
 * to show the call under, call the provider with its own key.
 */
function fakeGateway(provider: typeof fetch): {
  fetch: typeof fetch;
  effects: (GatewayRequest['effect'] | undefined)[];
} {
  const effects: (GatewayRequest['effect'] | undefined)[] = [];
  const { fetch } = fakeFetch(async (call) => {
    // What the client sent the gateway.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const { effect, ...asked } = call.body as GatewayRequest;
    effects.push(effect);
    const credentials = readCredentials(asked.provider, { apiKey: 'sk-ours' });
    const response: LlmResponse = await callProvider(asked, credentials, { fetch: provider });
    return { body: response };
  });
  return { fetch, effects };
}

describe('a gateway built on callProvider', () => {
  it('answers what the provider answered, called with its own key', async () => {
    const provider = fakeFetch(() => ({ body: responsesBody([]) }));
    const gateway = fakeGateway(provider.fetch);
    const llm = createLlm({ secrets: secrets(gatewaySecrets) }, { fetch: gateway.fetch });
    const response = await llm.complete({ provider: 'openai', model: 'gpt-6.1-sol', messages: [] });
    expect(response).toMatchObject({ provider: 'openai', id: 'resp_1', stopReason: 'stop' });
    expect(provider.sent[0]?.headers.get('authorization')).toBe('Bearer sk-ours');
    expect(provider.sent[0]?.body).not.toHaveProperty('effect');
  });

  it('refuses credentials that are not a key', () => {
    expect(() => readCredentials('openai', { apiKey: '' })).toThrow(/credentials.apiKey/);
    expect(() => readCredentials('openai', { project: 'p' })).toThrow(/apiKey is missing/);
  });
});

describe('in a handler', () => {
  it('calls the model with the runner’s secrets, and step reads the reply or the failure', async () => {
    type Snapshot = { reply: string | null; failure: string | null };
    const agent: Agent<Snapshot> = {
      name: 'chat',
      version: '1',
      kinds: ['llm'],
      init: () => ({ snapshot: { reply: null, failure: null } }),
      step: ({ snapshot }, message) => {
        if (message.type !== 'effect') return { snapshot };
        const { outcome } = message;
        if ('ok' in outcome) {
          // The handler returned an LlmResponse.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const response = outcome.ok as unknown as LlmResponse;
          return { snapshot: { ...snapshot, reply: outputText(response.message) } };
        }
        return { snapshot: { ...snapshot, failure: llmFailure(outcome)?.kind ?? 'other' } };
      },
      effects: ({ snapshot }) =>
        snapshot.reply === null && snapshot.failure === null
          ? [{ key: 'llm:1', kind: 'llm', args: null }]
          : [],
    };
    const { fetch } = fakeFetch(() => ({ body: anthropicBody([{ type: 'text', text: 'Hello' }]) }));
    const handlers: Handlers = {
      llm: { mode: 'reissue', run: (ctx) => createLlm(ctx, { fetch }).complete(request) },
    };

    const runner = createMemoryRunner({
      secrets: llmSecrets({ ANTHROPIC_API_KEY: 'sk-ant', HOME: '/x' }),
    });
    const { id } = runner.create(runner.load(agent, handlers), {});
    if (id === undefined) throw new Error('not created');
    expect(await settled(() => runner.snapshot(id))).toEqual({ reply: 'Hello', failure: null });

    const keyless = createMemoryRunner();
    const other = keyless.create(keyless.load(agent, handlers), {}).id;
    if (other === undefined) throw new Error('not created');
    expect(await settled(() => keyless.snapshot(other))).toEqual({ reply: null, failure: 'auth' });

    // Through the gateway, which shows the call under the effect the runner ran.
    const gateway = fakeGateway(fetch);
    const viaGateway = createMemoryRunner({ secrets: llmSecrets(gatewaySecrets) });
    const third = viaGateway.create(
      viaGateway.load(agent, {
        llm: {
          mode: 'reissue',
          run: (ctx) => createLlm(ctx, { fetch: gateway.fetch }).complete(request),
        },
      }),
      {},
    ).id;
    if (third === undefined) throw new Error('not created');
    expect(await settled(() => viaGateway.snapshot(third))).toEqual({
      reply: 'Hello',
      failure: null,
    });
    expect(gateway.effects).toEqual([{ key: 'llm:1', kind: 'llm', attempt: 1 }]);
    runner.close();
    keyless.close();
    viaGateway.close();
  });
});

async function settled(read: () => JsonObject): Promise<JsonObject> {
  for (let tries = 0; tries < 100; tries += 1) {
    const value = read();
    if (value['reply'] !== null || value['failure'] !== null) return value;
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the runner did not settle');
}
