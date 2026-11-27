// Signing in with ChatGPT, as OpenAI's Sign in with ChatGPT has it for an open-source
// application that uses the plan of the person who signs in: authorization with a code and
// PKCE, back to an address on the person's own computer, and an OpenID Connect ID token.
//
// The engine is often not on the computer whose browser signs in, so nothing listens at that
// address: the page there does not load, and the person gives its address to the engine, which
// finishes the sign-in with it.
//
// The first sign-in of an account registers this application for it at OpenAI, which answers
// with the account's own client ID. That ID renews the token, ends the sign-in, and signs the
// account in again.
//
// https://developers.openai.com/siwc/token-sharing-open-source/sign-in

import type { webcrypto } from 'node:crypto';

import type { Json, JsonObject } from '@acentric/protocol';

import { ModelFailure } from '../failure.ts';
import { isObject } from '../json.ts';
import { SignInRefused } from '../provider.ts';
import type { Credential, SignInFlow, SignInSettings } from '../provider.ts';

const ISSUER = 'https://auth.openai.com';
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
// As `https://auth.openai.com/.well-known/openid-configuration` names them.
const REVOKE_URL = `${ISSUER}/api/accounts/oauth/revoke`;
const KEYS_URL = `${ISSUER}/.well-known/jwks.json`;

/** What the first sign-in of an account is started with. It is never kept. */
const REGISTERING = 'dynamic_agent_client';
/** The application's name, as OpenAI shows it to the person. */
const NAME = 'Acentric';
/** Only the port of it may change; nothing listens there. */
const RETURN_TO = 'http://127.0.0.1:1455/auth/callback';
const RESOURCE = 'https://api.openai.com/v1';
/** What lets the plan pay for calls: a sign-in without it makes no account. */
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;

/** The codes of a refresh token that will never be taken again. */
const ENDED = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
  'invalid_client',
]);

/** The longest OpenAI's sign-in is waited for, in milliseconds, for each call. */
const CALL_MS = 30_000;
/** How far apart OpenAI's clock and this one may be, in seconds. */
const SKEW_S = 60;

const PROVIDER = 'chatgpt';

/** What the engine keeps of a ChatGPT sign-in, besides its token. */
type Session = {
  readonly clientId: string;
  readonly refreshToken: string;
  readonly idToken: string;
  readonly subject: string;
  readonly email: string | null;
  readonly scopes: readonly string[];
};

/** What a sign-in keeps until it is finished. */
type Pending = {
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  /** The account's own client ID, for one signed in again. */
  readonly clientId: string | null;
  /** Whose the account is, for one signed in again: no one else's sign-in is taken for it. */
  readonly subject: string | null;
};

function random(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function sessionOf(credential: Credential): Session {
  const session = credential.type === 'access_token' ? credential.session : undefined;
  if (
    session === undefined ||
    typeof session['clientId'] !== 'string' ||
    typeof session['refreshToken'] !== 'string'
  ) {
    throw new ModelFailure('This is not a ChatGPT sign-in: sign in with ChatGPT again', 'auth', {
      provider: PROVIDER,
    });
  }
  return session as unknown as Session;
}

function pendingOf(pending: JsonObject): Pending {
  return pending as unknown as Pending;
}

export const chatGptSignIn: SignInFlow = {
  waitsMs: 10 * 60 * 1000,

  async start({ host, again, client }) {
    const before = again === undefined ? undefined : sessionOf(again);
    // The account's own client, or the one OpenAI registered for a sign-in that did not finish.
    const issued = before?.clientId ?? client;
    const verifier = random();
    const challenge = base64url(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
    );
    const pending: Pending = {
      state: random(),
      nonce: random(),
      verifier,
      clientId: issued ?? null,
      subject: before?.subject ?? null,
    };
    const query = new URLSearchParams({
      client_id: issued ?? REGISTERING,
      // Only when registering: the name a person sees, and may change, for this application.
      ...(issued === undefined ? { agent_name_hint: NAME } : {}),
      ext_agent_host_id: host,
      // The account signed in again, so that OpenAI need not ask which.
      ...(before === undefined ? {} : { id_token_hint: before.idToken }),
      ...(before?.email == null ? {} : { login_hint: before.email }),
      response_type: 'code',
      redirect_uri: RETURN_TO,
      scope: SCOPES,
      resource: RESOURCE,
      state: pending.state,
      nonce: pending.nonce,
      code_challenge_method: 'S256',
      code_challenge: challenge,
    });
    return {
      url: `${AUTHORIZE_URL}?${query.toString()}`,
      pending: pending as unknown as JsonObject,
    };
  },

  async finish(given, returned, settings) {
    const pending = pendingOf(given);
    const answer = returnedQuery(returned);
    // Before anything else: an address of another sign-in says nothing of this one.
    if (answer.get('state') !== pending.state) {
      throw new SignInRefused(
        'That is not the address of this sign-in: paste the address of the page the sign-in you just finished went to',
      );
    }
    const error = answer.get('error');
    if (error !== null) {
      if (error === 'access_denied') {
        throw new SignInRefused('The sign-in was declined at ChatGPT');
      }
      const said = answer.get('error_description');
      throw new SignInRefused(`ChatGPT did not sign in: ${said ?? error}`);
    }
    const code = answer.get('code');
    if (code === null || code === '') {
      throw new SignInRefused('That address has no sign-in code in it');
    }
    const named = answer.get('client_id');
    let clientId: string;
    if (pending.clientId === null) {
      // A first sign-in: OpenAI names the client it registered.
      if (named === null || named === '' || named === REGISTERING) {
        throw new SignInRefused(
          'ChatGPT did not finish registering Acentric for this account: sign in again',
        );
      }
      clientId = named;
    } else {
      if (named !== null && named !== pending.clientId) {
        throw new SignInRefused(
          'ChatGPT answered for another registration of Acentric than this account’s: sign in again',
        );
      }
      clientId = pending.clientId;
    }

    const tokens = await tokenCall(
      {
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: pending.verifier,
        redirect_uri: RETURN_TO,
        resource: RESOURCE,
      },
      settings,
      (failure) => {
        if (failure !== 'invalid_grant') return undefined;
        // OpenAI says to start again with the client it registered, not to register again.
        return new SignInRefused(
          'ChatGPT did not take that sign-in’s code: open OpenAI’s page again, and paste the address it goes to as soon as it does',
          { client: clientId },
        );
      },
    );
    const idToken = text(tokens['id_token']);
    if (idToken === undefined) throw badAnswer('no ID token');
    const claims = await verifiedClaims(idToken, clientId, pending.nonce, settings);
    const subject = claims['sub'] as string;
    if (pending.subject !== null && subject !== pending.subject) {
      throw new SignInRefused(
        'That is another ChatGPT account than this one: sign in with the account it was made with',
      );
    }
    const scopes = scopesOf(tokens);
    if (!scopes.includes(PLAN_SCOPE)) {
      throw new SignInRefused(
        'Acentric was not allowed to use the ChatGPT plan: sign in again and allow it',
      );
    }
    const refreshToken = text(tokens['refresh_token']);
    if (refreshToken === undefined) throw badAnswer('no refresh token');
    const email = text(claims['email']) ?? null;
    const session: Session = { clientId, refreshToken, idToken, subject, email, scopes };
    return { credential: credentialOf(tokens, session), email };
  },

  async renew(credential, settings) {
    const before = sessionOf(credential);
    const tokens = await tokenCall(
      {
        grant_type: 'refresh_token',
        client_id: before.clientId,
        refresh_token: before.refreshToken,
        resource: RESOURCE,
      },
      settings,
      (failure) =>
        ENDED.has(failure)
          ? new ModelFailure('The ChatGPT sign-in has ended: sign the account in again', 'auth', {
              provider: PROVIDER,
              code: failure,
            })
          : undefined,
    );
    const scopes =
      tokens['scope'] === undefined && tokens['scopes'] === undefined
        ? before.scopes
        : scopesOf(tokens);
    return credentialOf(tokens, {
      ...before,
      // The refresh token is replaced each time; the ID token, when a new one comes.
      refreshToken: text(tokens['refresh_token']) ?? before.refreshToken,
      idToken: text(tokens['id_token']) ?? before.idToken,
      scopes,
    });
  },

  async end(credential, settings) {
    const session = sessionOf(credential);
    const response = await send(
      REVOKE_URL,
      {
        token: session.refreshToken,
        token_type_hint: 'refresh_token',
        client_id: session.clientId,
      },
      settings,
    );
    await response.body?.cancel().catch(() => {});
    if (response.status !== 200) {
      throw new ModelFailure(
        `ChatGPT answered ${String(response.status)} when the sign-in was ended`,
        response.status >= 500 ? 'provider_error' : 'invalid_request',
        { provider: PROVIDER, status: response.status },
      );
    }
  },
};

/** The query of the address a browser was sent back to: all of it, or only its query. */
function returnedQuery(returned: string): URLSearchParams {
  const given = returned.trim();
  try {
    return new URL(given).searchParams;
  } catch {
    return new URLSearchParams(given.replace(/^[^?]*\?/, ''));
  }
}

function text(value: Json | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function scopesOf(tokens: JsonObject): string[] {
  const given = tokens['scope'] ?? tokens['scopes'];
  if (Array.isArray(given)) return given.filter((scope) => typeof scope === 'string');
  return typeof given === 'string' ? given.split(' ').filter((scope) => scope !== '') : [];
}

/** The credential a token answer makes, with what the engine keeps to renew and end it. */
function credentialOf(tokens: JsonObject, session: Session): Credential {
  const accessToken = text(tokens['access_token']);
  if (accessToken === undefined) throw badAnswer('no access token');
  const seconds = tokens['expires_in'];
  const lasts = typeof seconds === 'number' && seconds > 0 ? seconds : 3600;
  return {
    type: 'access_token',
    accessToken,
    expiresAt: Date.now() + lasts * 1000,
    session: session as unknown as JsonObject,
  };
}

function badAnswer(what: string): ModelFailure {
  return new ModelFailure(`ChatGPT's sign-in answered with ${what}`, 'invalid_response', {
    provider: PROVIDER,
  });
}

async function send(
  url: string,
  form: { readonly [field: string]: string },
  settings: SignInSettings,
): Promise<Response> {
  try {
    return await (settings.fetch ?? fetch)(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(CALL_MS),
    });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new ModelFailure(`ChatGPT's sign-in could not be reached: ${why}`, 'network', {
      provider: PROVIDER,
    });
  }
}

/**
 * A call of the token endpoint, and its answer. `refused` says what a failure of OpenAI's
 * code means here, when it means more than that the call failed.
 */
async function tokenCall(
  form: { readonly [field: string]: string },
  settings: SignInSettings,
  refused: (code: string) => Error | undefined,
): Promise<JsonObject> {
  const response = await send(TOKEN_URL, form, settings);
  let body: Json | undefined;
  try {
    body = (await response.json()) as Json;
  } catch {
    body = undefined;
  }
  if (response.ok && isObject(body)) return body;
  const error = isObject(body) ? body['error'] : undefined;
  const code =
    typeof error === 'string' ? error : isObject(error) ? text(error['code']) : undefined;
  const said = isObject(body)
    ? (text(body['error_description']) ?? (isObject(error) ? text(error['message']) : undefined))
    : undefined;
  const meant = code === undefined ? undefined : refused(code);
  if (meant !== undefined) throw meant;
  throw new ModelFailure(
    `ChatGPT's sign-in answered ${String(response.status)}${said === undefined ? '' : `: ${said}`}`,
    response.status >= 500
      ? 'provider_error'
      : response.ok
        ? 'invalid_response'
        : 'invalid_request',
    { provider: PROVIDER, status: response.status, ...(code === undefined ? {} : { code }) },
  );
}

/**
 * The claims of an ID token, once its signature is checked against OpenAI's published keys,
 * and that it is OpenAI's, for this client, unexpired and of this sign-in.
 */
async function verifiedClaims(
  token: string,
  clientId: string,
  nonce: string,
  settings: SignInSettings,
): Promise<JsonObject> {
  const [head, body, signature] = token.split('.');
  if (head === undefined || body === undefined || signature === undefined) {
    throw badAnswer('an ID token that is not one');
  }
  const header = decoded(head);
  const claims = decoded(body);
  if (header['alg'] !== 'RS256') throw badAnswer('an ID token not signed with RS256');
  const key = await publicKey(text(header['kid']), settings);
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    Buffer.from(signature, 'base64url'),
    new TextEncoder().encode(`${head}.${body}`),
  );
  if (!valid) throw badAnswer('an ID token whose signature is not OpenAI’s');
  const audience = claims['aud'];
  const audiences = Array.isArray(audience) ? audience : [audience];
  const now = Date.now() / 1000;
  const expires = claims['exp'];
  if (claims['iss'] !== ISSUER) throw badAnswer('an ID token of another issuer');
  if (!audiences.includes(clientId)) throw badAnswer('an ID token for another client');
  if (typeof expires !== 'number' || expires + SKEW_S < now) {
    throw badAnswer('an ID token that has expired');
  }
  if (claims['nonce'] !== nonce) throw badAnswer('an ID token of another sign-in');
  if (text(claims['sub']) === undefined) throw badAnswer('an ID token that names no one');
  return claims;
}

function decoded(part: string): JsonObject {
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Json;
    if (isObject(value)) return value;
  } catch {
    // Said below.
  }
  throw badAnswer('an ID token that is not one');
}

/** OpenAI's key that `kid` names, from the keys it publishes. */
async function publicKey(
  kid: string | undefined,
  settings: SignInSettings,
): Promise<webcrypto.CryptoKey> {
  let keys: Json | undefined;
  try {
    const response = await (settings.fetch ?? fetch)(KEYS_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(CALL_MS),
    });
    if (!response.ok) {
      throw new Error(`it answered ${String(response.status)}`);
    }
    keys = (await response.json()) as Json;
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new ModelFailure(`ChatGPT's signing keys could not be read: ${why}`, 'network', {
      provider: PROVIDER,
    });
  }
  const list = isObject(keys) && Array.isArray(keys['keys']) ? keys['keys'] : [];
  const jwk = list.find(
    (each): each is JsonObject =>
      isObject(each) && each['kty'] === 'RSA' && (kid === undefined || each['kid'] === kid),
  );
  if (jwk === undefined) throw badAnswer('an ID token signed with a key it does not publish');
  return crypto.subtle.importKey(
    'jwk',
    jwk as webcrypto.JsonWebKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
}
