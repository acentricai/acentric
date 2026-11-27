// Signing in with ChatGPT, against a stand-in for OpenAI's sign-in that signs its ID tokens
// with a key of its own, as OpenAI's does, and answers what OpenAI's documentation says it does.

import type { webcrypto } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import type { JsonObject } from '@acentric/protocol';

import { ModelFailure, SignInRefused, chatGptSignIn } from '../src/index.ts';
import type { Credential } from '../src/index.ts';

const HOST = 'urn:uuid:4f9c2a5e-7d1b-4c3a-9e8f-1a2b3c4d5e6f';
const CLIENT = 'oaiapp_issued-for-alice';
const RETURN_TO = 'http://127.0.0.1:1455/auth/callback';

type Key = { readonly privateKey: webcrypto.CryptoKey; readonly jwk: webcrypto.JsonWebKey };

let openai: Key;
let stranger: Key;

async function key(kid: string): Promise<Key> {
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
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid };
  return { privateKey: pair.privateKey, jwk };
}

beforeAll(async () => {
  openai = await key('openai-1');
  stranger = await key('openai-1');
});

const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

async function idToken(claims: object, by: Key = openai): Promise<string> {
  const signed = `${part({ alg: 'RS256', kid: 'openai-1', typ: 'JWT' })}.${part(claims)}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    by.privateKey,
    new TextEncoder().encode(signed),
  );
  return `${signed}.${Buffer.from(signature).toString('base64url')}`;
}

type Sent = { readonly url: string; readonly form: { [field: string]: string } };

/**
 * OpenAI's sign-in, as far as these tests ask of it. `token` answers the token endpoint;
 * `revoke` the revocation endpoint.
 */
function standIn(answers: {
  token?: (form: { [field: string]: string }) => Promise<Response> | Response;
  revoke?: () => Response;
}) {
  const sent: Sent[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://auth.openai.com/.well-known/jwks.json') {
      return Response.json({ keys: [openai.jwk] });
    }
    const form = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')));
    sent.push({ url, form });
    if (url === 'https://auth.openai.com/api/accounts/oauth/token' && answers.token) {
      return answers.token(form);
    }
    if (url === 'https://auth.openai.com/api/accounts/oauth/revoke' && answers.revoke) {
      return answers.revoke();
    }
    return new Response('not here', { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

const now = () => Math.floor(Date.now() / 1000);

/** A token answer for a sign-in, its ID token made from `claims`. */
async function tokens(
  claims: object,
  more: { scope?: string; by?: Key; refresh?: string } = {},
): Promise<Response> {
  return Response.json({
    access_token: 'access-1',
    refresh_token: more.refresh ?? 'refresh-1',
    id_token: await idToken(
      { iss: 'https://auth.openai.com', aud: [CLIENT], exp: now() + 3600, iat: now(), ...claims },
      more.by,
    ),
    token_type: 'Bearer',
    expires_in: 3600,
    scope:
      more.scope ?? 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke',
  });
}

/** A sign-in started, and what its page was asked with. */
async function started(again?: Credential) {
  const { url, pending } = await chatGptSignIn.start({
    host: HOST,
    ...(again === undefined ? {} : { again }),
  });
  return { url: new URL(url), query: new URL(url).searchParams, pending };
}

/** The address OpenAI's sign-in sends the browser to. */
function returned(fields: { [field: string]: string }): string {
  return `${RETURN_TO}?${new URLSearchParams(fields).toString()}`;
}

/** A sign-in finished as OpenAI would finish it for alice, unless `claims` say otherwise. */
async function signIn(claims: object = {}, more: Parameters<typeof tokens>[1] = {}) {
  const { pending } = await started();
  const nonce = (pending as { nonce: string }).nonce;
  const stand = standIn({
    token: () => tokens({ sub: 'alice', email: 'alice@example.com', nonce, ...claims }, more),
  });
  const done = await chatGptSignIn.finish(
    pending,
    returned({ code: 'the-code', state: String(pending['state']), client_id: CLIENT }),
    { fetch: stand.fetch },
  );
  return { ...done, sent: stand.sent };
}

describe('starting a sign-in', () => {
  it('registers the application, from this host, for its plan', async () => {
    const { url, query, pending } = await started();
    expect(`${url.origin}${url.pathname}`).toBe('https://auth.openai.com/api/accounts/authorize');
    expect(Object.fromEntries(query)).toMatchObject({
      client_id: 'dynamic_agent_client',
      agent_name_hint: 'Acentric',
      ext_agent_host_id: HOST,
      response_type: 'code',
      redirect_uri: RETURN_TO,
      scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      resource: 'https://api.openai.com/v1',
      code_challenge_method: 'S256',
      state: pending['state'],
      nonce: pending['nonce'],
    });
    expect(query.has('id_token_hint')).toBe(false);
    // The challenge is the verifier's digest, which only the engine keeps.
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(String(pending['verifier'])),
    );
    expect(query.get('code_challenge')).toBe(Buffer.from(digest).toString('base64url'));
    expect(url.toString()).not.toContain(String(pending['verifier']));
  });

  it('is new each time', async () => {
    const [one, two] = await Promise.all([started(), started()]);
    expect(one.pending['state']).not.toBe(two.pending['state']);
    expect(one.pending['nonce']).not.toBe(two.pending['nonce']);
    expect(one.pending['verifier']).not.toBe(two.pending['verifier']);
  });
});

describe('finishing a sign-in', () => {
  it('makes a credential of the plan, which says whose it is', async () => {
    const { credential, email, sent } = await signIn();
    expect(email).toBe('alice@example.com');
    expect(credential).toMatchObject({
      type: 'access_token',
      accessToken: 'access-1',
      session: {
        clientId: CLIENT,
        refreshToken: 'refresh-1',
        subject: 'alice',
        email: 'alice@example.com',
      },
    });
    const expiresAt = credential.type === 'access_token' ? (credential.expiresAt ?? 0) : 0;
    expect(Math.abs(expiresAt - (Date.now() + 3_600_000))).toBeLessThan(10_000);
    // The code is traded with the client OpenAI registered, and the verifier.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.form).toMatchObject({
      grant_type: 'authorization_code',
      client_id: CLIENT,
      code: 'the-code',
      redirect_uri: RETURN_TO,
      resource: 'https://api.openai.com/v1',
    });
    expect(sent[0]?.form['code_verifier']).toMatch(/^[\w-]{43}$/);
  });

  it('takes the query of the address alone, as well as all of it', async () => {
    const { pending } = await started();
    const stand = standIn({ token: () => tokens({ sub: 'alice', nonce: pending['nonce'] }) });
    const done = await chatGptSignIn.finish(
      pending,
      `  code=c&state=${String(pending['state'])}&client_id=${CLIENT}  `,
      { fetch: stand.fetch },
    );
    expect(done.email).toBeNull();
  });

  it('refuses an address of another sign-in, before it asks OpenAI anything', async () => {
    const { pending } = await started();
    const stand = standIn({});
    await expect(
      chatGptSignIn.finish(pending, returned({ code: 'c', state: 'another', client_id: CLIENT }), {
        fetch: stand.fetch,
      }),
    ).rejects.toThrow(SignInRefused);
    expect(stand.sent).toEqual([]);
  });

  it('says when the person declined', async () => {
    const { pending } = await started();
    await expect(
      chatGptSignIn.finish(
        pending,
        returned({ error: 'access_denied', state: String(pending['state']) }),
        {},
      ),
    ).rejects.toThrow(/declined/);
  });

  it('refuses a first sign-in that OpenAI did not register', async () => {
    const { pending } = await started();
    for (const client of [{}, { client_id: 'dynamic_agent_client' }]) {
      await expect(
        chatGptSignIn.finish(
          pending,
          returned({ code: 'c', state: String(pending['state']), ...client }),
          {},
        ),
      ).rejects.toThrow(/did not finish registering/);
    }
  });

  it('makes no account of a sign-in that did not allow the plan', async () => {
    await expect(signIn({}, { scope: 'openid email profile offline_access' })).rejects.toThrow(
      /not allowed to use the ChatGPT plan/,
    );
  });

  it('takes only an ID token that OpenAI signed, for this client and this sign-in', async () => {
    await expect(signIn({}, { by: stranger })).rejects.toThrow(/signature/);
    await expect(signIn({ nonce: 'another' })).rejects.toThrow(/another sign-in/);
    await expect(signIn({ aud: ['oaiapp_another'] })).rejects.toThrow(/another client/);
    await expect(signIn({ iss: 'https://example.com' })).rejects.toThrow(/another issuer/);
    await expect(signIn({ exp: now() - 3600 })).rejects.toThrow(/expired/);
    await expect(signIn({ sub: '' })).rejects.toThrow(/names no one/);
  });

  it('starts a registration whose code was refused again with the client it registered', async () => {
    const { pending } = await started();
    const refusing = standIn({
      token: () => Response.json({ error: 'invalid_grant' }, { status: 400 }),
    });
    const refused = await chatGptSignIn
      .finish(
        pending,
        returned({ code: 'c', state: String(pending['state']), client_id: CLIENT }),
        { fetch: refusing.fetch },
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(refused).toBeInstanceOf(SignInRefused);
    expect(refused).toMatchObject({ client: CLIENT, message: /did not take that sign-in’s code/ });

    // Not registered once more: the client OpenAI registered, with no name to give it.
    const { pending: again, query } = await chatGptSignIn
      .start({ host: HOST, client: CLIENT })
      .then(({ url, pending: kept }) => ({ pending: kept, query: new URL(url).searchParams }));
    expect(query.get('client_id')).toBe(CLIENT);
    expect(query.has('agent_name_hint')).toBe(false);
    expect(query.has('id_token_hint')).toBe(false);
    expect(query.get('ext_agent_host_id')).toBe(HOST);
    // Its callback may leave the client out.
    const taking = standIn({ token: () => tokens({ sub: 'alice', nonce: again['nonce'] }) });
    const done = await chatGptSignIn.finish(
      again,
      returned({ code: 'c2', state: String(again['state']) }),
      { fetch: taking.fetch },
    );
    expect(done.credential).toMatchObject({ session: { clientId: CLIENT, subject: 'alice' } });
    expect(taking.sent[0]?.form['client_id']).toBe(CLIENT);
  });

  it('says a code refused for an account signed in again, which needs no new client', async () => {
    const { credential } = await signIn();
    const { pending } = await started(credential);
    const refusing = standIn({
      token: () => Response.json({ error: 'invalid_grant' }, { status: 400 }),
    });
    await expect(
      chatGptSignIn.finish(pending, returned({ code: 'c', state: String(pending['state']) }), {
        fetch: refusing.fetch,
      }),
    ).rejects.toMatchObject({ client: CLIENT });
  });
});

describe('signing in again', () => {
  it('signs in with the account’s own client, and only as the same person', async () => {
    const { credential } = await signIn();
    const { query, pending } = await started(credential);
    expect(query.get('client_id')).toBe(CLIENT);
    expect(query.has('agent_name_hint')).toBe(false);
    expect(query.get('ext_agent_host_id')).toBe(HOST);
    expect(query.get('id_token_hint')).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(query.get('login_hint')).toBe('alice@example.com');

    const as = (sub: string) =>
      standIn({ token: () => tokens({ sub, nonce: pending['nonce'] }) }).fetch;
    // A returning sign-in may leave the client out: it is the one it was started with.
    const address = returned({ code: 'c', state: String(pending['state']) });
    await expect(chatGptSignIn.finish(pending, address, { fetch: as('bob') })).rejects.toThrow(
      /another ChatGPT account/,
    );
    const again = await chatGptSignIn.finish(pending, address, { fetch: as('alice') });
    expect(again.credential).toMatchObject({ session: { clientId: CLIENT, subject: 'alice' } });
    await expect(
      chatGptSignIn.finish(
        pending,
        returned({ code: 'c', state: String(pending['state']), client_id: 'oaiapp_another' }),
        {},
      ),
    ).rejects.toThrow(/another registration/);
  });
});

describe('renewing a token', () => {
  it('trades the refresh token, and keeps the one that replaces it', async () => {
    const { credential } = await signIn();
    const stand = standIn({
      token: () =>
        Response.json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 }),
    });
    const renewed = await chatGptSignIn.renew(credential, { fetch: stand.fetch });
    expect(stand.sent[0]?.form).toEqual({
      grant_type: 'refresh_token',
      client_id: CLIENT,
      refresh_token: 'refresh-1',
      resource: 'https://api.openai.com/v1',
    });
    expect(renewed).toMatchObject({
      accessToken: 'access-2',
      session: {
        refreshToken: 'refresh-2',
        clientId: CLIENT,
        subject: 'alice',
        scopes: expect.arrayContaining(['chatgpt.tokens.use.direct']) as unknown,
      },
    });
  });

  it('says a sign-in that has ended, and a provider that could not be asked', async () => {
    const { credential } = await signIn();
    const failure = async (fetch: typeof globalThis.fetch): Promise<ModelFailure> => {
      try {
        await chatGptSignIn.renew(credential, { fetch });
      } catch (error) {
        return error as ModelFailure;
      }
      throw new Error('It was renewed');
    };
    for (const code of ['invalid_grant', 'refresh_token_reused', 'refresh_token_expired']) {
      const ended = await failure(
        standIn({ token: () => Response.json({ error: code }, { status: 400 }) }).fetch,
      );
      expect(ended).toMatchObject({ kind: 'auth', retryable: false });
      expect(ended.message).toMatch(/sign-in has ended/);
    }
    const down = await failure(standIn({ token: () => new Response('no', { status: 503 }) }).fetch);
    expect(down).toMatchObject({ kind: 'provider_error', retryable: true });
    const lost = await failure((async () => {
      throw new TypeError('fetch failed');
    }) as typeof globalThis.fetch);
    expect(lost).toMatchObject({ kind: 'network', retryable: true });
  });
});

describe('ending a sign-in', () => {
  it('revokes its refresh token with its client', async () => {
    const { credential } = await signIn();
    const stand = standIn({ revoke: () => new Response(null, { status: 200 }) });
    await chatGptSignIn.end(credential, { fetch: stand.fetch });
    expect(stand.sent).toEqual([
      {
        url: 'https://auth.openai.com/api/accounts/oauth/revoke',
        form: { token: 'refresh-1', token_type_hint: 'refresh_token', client_id: CLIENT },
      },
    ]);
    const down = standIn({ revoke: () => new Response('no', { status: 502 }) });
    await expect(chatGptSignIn.end(credential, { fetch: down.fetch })).rejects.toThrow(
      ModelFailure,
    );
  });

  it('is not asked of a credential that is not a ChatGPT sign-in', async () => {
    const keyed = { type: 'api_key', apiKey: 'k' } as const;
    await expect(chatGptSignIn.end(keyed, {})).rejects.toMatchObject({ kind: 'auth' });
  });
});

describe('what a sign-in keeps', () => {
  it('keeps nothing but what it needs, and no token in its page', async () => {
    const { credential } = await signIn();
    const { url, pending } = await started(credential);
    expect(Object.keys(pending).toSorted()).toEqual([
      'clientId',
      'nonce',
      'state',
      'subject',
      'verifier',
    ]);
    const session = (credential as { session: JsonObject }).session;
    expect(url.toString()).not.toContain(String(session['refreshToken']));
    expect(url.toString()).not.toContain('access-1');
  });
});
