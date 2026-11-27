// Signing in with ChatGPT through the API, as the dashboard does it, against a stand-in for
// OpenAI: its sign-in, which signs its ID tokens with a key of its own, and its Responses API,
// which answers a plan's calls only as a stream.

import type { webcrypto } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import type { Actor } from '@acentric/protocol';

import { api, refusal } from './api.ts';

const CLIENT = 'oaiapp_issued-for-alice';

let key: { readonly privateKey: webcrypto.CryptoKey; readonly jwk: webcrypto.JsonWebKey };

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  key = {
    privateKey: pair.privateKey,
    jwk: {
      ...(await crypto.subtle.exportKey('jwk', pair.publicKey)),
      kid: 'k',
    } as webcrypto.JsonWebKey,
  };
});

const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

async function idToken(claims: object): Promise<string> {
  const signed = `${part({ alg: 'RS256', kid: 'k' })}.${part(claims)}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key.privateKey,
    new TextEncoder().encode(signed),
  );
  return `${signed}.${Buffer.from(signature).toString('base64url')}`;
}

/**
 * OpenAI, as these tests ask of it, and what it was asked. `refuseFirst` refuses the code of
 * the first registration, as OpenAI may.
 */
function openai(refuseFirst = false) {
  const asked: { url: string; form?: { [field: string]: string }; auth?: string | null }[] = [];
  /** The nonce of the sign-in the next code is for. */
  let nonce = '';
  let issued = 0;
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (url === 'https://auth.openai.com/.well-known/jwks.json') {
      return Response.json({ keys: [key.jwk] });
    }
    if (url === 'https://api.openai.com/v1/responses') {
      asked.push({ url, auth: headers.get('authorization') });
      const events = [
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Hello.' }],
          },
        },
        {
          type: 'response.completed',
          response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 2 } },
        },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    const form = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')));
    asked.push({ url, form });
    if (url === 'https://auth.openai.com/api/accounts/oauth/token') {
      if (refuseFirst && form['grant_type'] === 'authorization_code' && issued === 0) {
        refuseFirst = false;
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      issued += 1;
      const now = Math.floor(Date.now() / 1000);
      return Response.json({
        access_token: `access-${String(issued)}`,
        refresh_token: `refresh-${String(issued)}`,
        ...(form['grant_type'] === 'authorization_code'
          ? {
              id_token: await idToken({
                iss: 'https://auth.openai.com',
                aud: [CLIENT],
                sub: 'alice',
                email: 'alice@example.com',
                exp: now + 3600,
                nonce,
              }),
            }
          : {}),
        // A token lasts a minute here: each call renews it first.
        expires_in: 60,
        scope: 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke',
      });
    }
    if (url === 'https://auth.openai.com/api/accounts/oauth/revoke') {
      return new Response(null, { status: 200 });
    }
    return new Response('not here', { status: 404 });
  }) as typeof globalThis.fetch;
  return {
    fetch,
    asked,
    /** The address the browser is sent to once a sign-in started at `url` is done. */
    returned(url: string, more: { [field: string]: string } = { client_id: CLIENT }) {
      const query = new URL(url).searchParams;
      nonce = query.get('nonce') ?? '';
      const back = new URL(query.get('redirect_uri') ?? '');
      back.search = new URLSearchParams({
        code: 'the-code',
        state: query.get('state') ?? '',
        ...more,
      }).toString();
      return back.toString();
    },
  };
}

describe('signing in with ChatGPT', () => {
  it('makes a ChatGPT account, whose calls are made on the plan with its token', async () => {
    const outside = openai();
    const { admin, accounts, failures } = await api([], { chatgpt: outside.fetch });
    const signIn = await admin.call('chatgptSignIns.create', { body: { name: 'plan' } });
    const page = new URL(signIn.url);
    expect(page.origin).toBe('https://auth.openai.com');
    expect(page.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(page.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/);

    // An address of another sign-in finishes nothing, and this one still waits.
    expect(
      await refusal(
        admin.call('chatgptSignIns.finish', {
          params: { signIn: signIn.id },
          body: { url: 'http://127.0.0.1:1455/auth/callback?code=x&state=another' },
        }),
      ),
    ).toEqual({ code: 'invalid_request', status: 400 });

    const account = await admin.call('chatgptSignIns.finish', {
      params: { signIn: signIn.id },
      body: { url: outside.returned(signIn.url) },
    });
    expect(account).toMatchObject({
      provider: 'chatgpt',
      name: 'plan',
      credential: 'access_token',
      signIn: { email: 'alice@example.com' },
      default: true,
    });
    const listed = JSON.stringify(await admin.call('accounts.list'));
    expect(listed).not.toContain('access-1');
    expect(listed).not.toContain('refresh-1');
    expect(listed).not.toContain(CLIENT);

    const { runner } = await accounts.access({ account: account.id } as Actor, 'chatgpt');
    const step = {
      model: 'gpt-6.2-sol',
      reasoning: 'low' as const,
      instructions: '',
      tools: [],
      messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hi.' }] }],
    };
    const answer = await runner.run(step, new AbortController().signal);
    expect(answer.message.content).toEqual([
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello.' }] },
    ]);
    await runner.run(step, new AbortController().signal);
    // A token lasts a minute, so each call renews it first, with the refresh token the last
    // renewal left.
    const calls = outside.asked.filter((one) => one.url.endsWith('/v1/responses'));
    expect(calls.map((one) => one.auth)).toEqual(['Bearer access-2', 'Bearer access-3']);
    const renewals = outside.asked.filter((one) => one.form?.['grant_type'] === 'refresh_token');
    expect(renewals.map((one) => one.form?.['refresh_token'])).toEqual(['refresh-1', 'refresh-2']);
    expect(renewals.map((one) => one.form?.['client_id'])).toEqual([CLIENT, CLIENT]);
    expect(failures).toEqual([]);
  });

  it('signs an account in again, is given up, and ends a sign-in when its account goes', async () => {
    const outside = openai();
    const { admin, failures } = await api([], { chatgpt: outside.fetch, account: false });
    const first = await admin.call('chatgptSignIns.create', { body: { name: 'plan' } });
    const account = await admin.call('chatgptSignIns.finish', {
      params: { signIn: first.id },
      body: { url: outside.returned(first.url) },
    });

    const again = await admin.call('chatgptSignIns.create', { body: { account: account.id } });
    expect(again.account).toBe(account.id);
    const page = new URL(again.url).searchParams;
    expect(page.get('client_id')).toBe(CLIENT);
    expect(page.get('login_hint')).toBe('alice@example.com');
    expect(
      await admin.call('chatgptSignIns.finish', {
        params: { signIn: again.id },
        body: { url: outside.returned(again.url, {}) },
      }),
    ).toMatchObject({ id: account.id, signIn: { email: 'alice@example.com' } });

    const left = await admin.call('chatgptSignIns.create', { body: { name: 'other' } });
    await admin.call('chatgptSignIns.delete', { params: { signIn: left.id } });
    expect(
      await refusal(
        admin.call('chatgptSignIns.finish', {
          params: { signIn: left.id },
          body: { url: outside.returned(left.url) },
        }),
      ),
    ).toEqual({ code: 'not_found', status: 404 });
    expect(await refusal(admin.call('chatgptSignIns.create', { body: { name: 'plan' } }))).toEqual({
      code: 'name_taken',
      status: 409,
    });

    await admin.call('accounts.delete', { params: { account: account.id } });
    const revoked = outside.asked.filter((one) => one.url.endsWith('/oauth/revoke'));
    expect(revoked.map((one) => one.form)).toEqual([
      { token: 'refresh-2', token_type_hint: 'refresh_token', client_id: CLIENT },
    ]);
    expect(failures).toEqual([]);
  });

  it('starts again with the client OpenAI registered, when OpenAI refuses the first code', async () => {
    const outside = openai(true);
    const { admin, failures } = await api([], { chatgpt: outside.fetch, account: false });
    const signIn = await admin.call('chatgptSignIns.create', { body: { name: 'plan' } });
    expect(
      await refusal(
        admin.call('chatgptSignIns.finish', {
          params: { signIn: signIn.id },
          body: { url: outside.returned(signIn.url) },
        }),
      ),
    ).toEqual({ code: 'invalid_request', status: 400 });
    const again = await admin.call('chatgptSignIns.get', { params: { signIn: signIn.id } });
    const page = new URL(again.url).searchParams;
    expect(page.get('client_id')).toBe(CLIENT);
    expect(page.has('agent_name_hint')).toBe(false);
    expect(page.get('state')).not.toBe(new URL(signIn.url).searchParams.get('state'));
    const account = await admin.call('chatgptSignIns.finish', {
      params: { signIn: signIn.id },
      body: { url: outside.returned(again.url, {}) },
    });
    expect(account).toMatchObject({ provider: 'chatgpt', name: 'plan' });
    const exchanges = outside.asked.filter(
      (one) => one.form?.['grant_type'] === 'authorization_code',
    );
    expect(exchanges.map((one) => one.form?.['client_id'])).toEqual([CLIENT, CLIENT]);
    expect(failures).toEqual([]);
  });

  it('is refused to whoever may not manage accounts', async () => {
    const outside = openai();
    const { keyed } = await api([], { chatgpt: outside.fetch });
    const { client } = await keyed({ scope: { type: 'engine' }, permissions: ['agents:read'] });
    expect(await refusal(client.call('chatgptSignIns.create', { body: { name: 'plan' } }))).toEqual(
      { code: 'forbidden', status: 403 },
    );
  });
});
