// Accounts made by signing in: the sign-in that makes one or signs one in again, and the
// token that is renewed before it stops being taken, with a provider whose sign-in is a
// stand-in that says what it was asked.

import { describe, expect, it } from 'vitest';

import { ModelFailure, Providers, SignInRefused } from '@acentric/ai';
import type { Credential, ModelRunner, ModelStep, SignInFlow } from '@acentric/ai';
import { fakeProvider, says } from '@acentric/ai/testing';
import type { Actor, JsonObject } from '@acentric/protocol';

import { Accounts } from '../src/accounts.ts';
import { Audit } from '../src/audit.ts';
import { MemoryStore } from '../src/memory-store.ts';
import { Secrets } from '../src/secrets.ts';
import { SignInNotFound, SignIns } from '../src/sign-ins.ts';

const NOW = 1_795_305_600_000;
const HOUR = 3_600_000;
const BY = { type: 'system' } as const;

const step: ModelStep = {
  model: 'fake-1',
  reasoning: 'low',
  instructions: '',
  tools: [],
  messages: [],
};

function world() {
  let now = NOW;
  const store = new MemoryStore();
  const audit = new Audit({ store, clock: () => now });
  const secrets = new Secrets({
    store,
    keys: { current: 'k1', keys: { k1: new Uint8Array(32).fill(1) } },
  });
  let made = 0;
  const token = (subject: string): Credential => {
    made += 1;
    return {
      type: 'access_token',
      accessToken: `token-${String(made)}`,
      expiresAt: now + HOUR,
      session: { subject },
    };
  };
  const started: { host: string; again?: Credential; client?: string }[] = [];
  const renewed: string[] = [];
  const ended: string[] = [];
  /** What renewing does instead of renewing, when a test says. */
  const renewing: { fails?: Error | undefined; waits?: Promise<void> | undefined } = {};
  const flow: SignInFlow = {
    waitsMs: 10 * 60 * 1000,
    async start(given) {
      started.push(given);
      const state = `state-${String(started.length)}`;
      const subject =
        given.again?.type === 'access_token' ? String(given.again.session?.['subject']) : null;
      return { url: `https://sign.example/?state=${state}`, pending: { state, subject } };
    },
    async finish(pending: JsonObject, returned) {
      const address = new URL(returned);
      if (address.searchParams.get('state') !== pending['state']) {
        throw new SignInRefused('That is not the address of this sign-in');
      }
      if (address.searchParams.has('refused')) {
        throw new SignInRefused('The code was not taken', { client: 'issued-client' });
      }
      if (address.searchParams.has('down')) {
        throw new ModelFailure('The provider could not be reached', 'network');
      }
      const who = address.searchParams.get('who') ?? 'alice';
      if (pending['subject'] !== null && who !== pending['subject']) {
        throw new SignInRefused('That is another account');
      }
      return { credential: token(who), email: `${who}@example.com` };
    },
    async renew(credential) {
      if (credential.type !== 'access_token') throw new Error('not a sign-in');
      renewed.push(credential.accessToken);
      await renewing.waits;
      if (renewing.fails !== undefined) throw renewing.fails;
      return token(String(credential.session?.['subject']));
    },
    async end(credential) {
      if (credential.type === 'access_token') ended.push(credential.accessToken);
    },
  };
  /** The tokens calls were made with, and those the provider refuses. */
  const calledWith: string[] = [];
  const refused = new Set<string>();
  const provider = {
    ...fakeProvider({ run: async () => says('unused') }),
    id: 'plan',
    label: 'Plan',
    credentials: ['access_token'] as const,
    signIn: flow,
    runner: ({ credential }: { credential: Credential }): ModelRunner => ({
      async run() {
        const used = credential.type === 'access_token' ? credential.accessToken : '';
        calledWith.push(used);
        if (refused.has(used)) throw new ModelFailure('The token is not taken', 'auth');
        return says('Hello.');
      },
    }),
  };
  const keyed = fakeProvider({ run: async () => says('Hi.') }, { keys: ['good'] });
  const providers = new Providers([provider, keyed]);
  const accounts = new Accounts({ store, secrets, providers, audit, clock: () => now });
  const signIns = new SignIns({ store, providers, accounts, clock: () => now });

  /** Signs in for a new account of `name`, as `who`. */
  const signUp = async (name: string, who = 'alice') => {
    const signIn = await signIns.start('plan', { name });
    const state = new URL(signIn.url).searchParams.get('state') ?? '';
    return signIns.finish(BY, signIn.id, `http://127.0.0.1:1455/cb?state=${state}&who=${who}`);
  };
  const call = async (account: string) => {
    const { runner } = await accounts.access({ account } as Actor, 'plan');
    return runner.run(step, new AbortController().signal);
  };
  return {
    store,
    accounts,
    signIns,
    started,
    renewed,
    ended,
    renewing,
    calledWith,
    refused,
    signUp,
    call,
    later: (ms: number) => {
      now += ms;
    },
  };
}

describe('signing in for an account', () => {
  it('makes an account of the sign-in, which says whose it is', async () => {
    const w = world();
    const account = await w.signUp('work');
    expect(account).toMatchObject({
      provider: 'plan',
      name: 'work',
      credential: 'access_token',
      signIn: { email: 'alice@example.com' },
      default: true,
    });
    // Signed in from this engine, as the same host each time.
    const host = await w.store.hostId();
    expect(host).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    await w.signUp('home', 'bob');
    expect(w.started.map((one) => one.host)).toEqual([host, host]);
    await w.call(account.id);
    expect(w.calledWith).toEqual(['token-1']);
  });

  it('says a name that is taken before anyone signs in', async () => {
    const w = world();
    await w.signUp('work');
    await expect(w.signIns.start('plan', { name: 'work' })).rejects.toMatchObject({
      code: 'name_taken',
    });
    expect(w.started).toHaveLength(1);
  });

  it('is only of a provider that is signed in to', async () => {
    const w = world();
    await expect(w.signIns.start('fake', { name: 'x' })).rejects.toThrow(/made with a key/);
    await expect(w.signIns.start('none', { name: 'x' })).rejects.toThrow(/no provider/);
  });

  it('waits for the right address, and is not finished twice', async () => {
    const w = world();
    const signIn = await w.signIns.start('plan', { name: 'work' });
    const state = new URL(signIn.url).searchParams.get('state') ?? '';
    await expect(
      w.signIns.finish(BY, signIn.id, 'http://127.0.0.1:1455/cb?state=wrong'),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      w.signIns.finish(BY, signIn.id, `http://127.0.0.1:1455/cb?state=${state}&down=1`),
    ).rejects.toMatchObject({ code: 'provider_failed' });
    await w.signIns.finish(BY, signIn.id, `http://127.0.0.1:1455/cb?state=${state}`);
    await expect(
      w.signIns.finish(BY, signIn.id, `http://127.0.0.1:1455/cb?state=${state}`),
    ).rejects.toThrow(SignInNotFound);
    expect(await w.accounts.list()).toHaveLength(1);
  });

  it('waits again, on a new page, when the provider refuses it with what it registered', async () => {
    const w = world();
    const signIn = await w.signIns.start('plan', { name: 'work' });
    const state = new URL(signIn.url).searchParams.get('state') ?? '';
    w.later(9 * 60 * 1000);
    await expect(
      w.signIns.finish(BY, signIn.id, `http://127.0.0.1:1455/cb?state=${state}&refused=1`),
    ).rejects.toThrow('The code was not taken');
    expect(w.started.at(-1)).toMatchObject({ client: 'issued-client' });
    const now = w.signIns.get(signIn.id);
    expect(now.url).not.toBe(signIn.url);
    // It waits as long again from now.
    expect(now.expiresAt).toBe(NOW + 9 * 60 * 1000 + 10 * 60 * 1000);
    // The address of the page before finishes nothing; that of the new one does.
    await expect(
      w.signIns.finish(BY, signIn.id, `http://127.0.0.1:1455/cb?state=${state}`),
    ).rejects.toThrow(/not the address/);
    const again = new URL(now.url).searchParams.get('state') ?? '';
    const account = await w.signIns.finish(
      BY,
      signIn.id,
      `http://127.0.0.1:1455/cb?state=${again}`,
    );
    expect(account.name).toBe('work');
    expect(() => w.signIns.get(signIn.id)).toThrow(SignInNotFound);
  });

  it('is given up, or expires', async () => {
    const w = world();
    const one = await w.signIns.start('plan', { name: 'one' });
    w.signIns.cancel(one.id);
    expect(() => w.signIns.cancel(one.id)).toThrow(SignInNotFound);
    const two = await w.signIns.start('plan', { name: 'two' });
    expect(two.expiresAt).toBe(NOW + 10 * 60 * 1000);
    w.later(10 * 60 * 1000);
    await expect(w.signIns.finish(BY, two.id, two.url)).rejects.toThrow(SignInNotFound);
  });

  it('ends a sign-in whose account could not be made', async () => {
    const w = world();
    const signIn = await w.signIns.start('plan', { name: 'work' });
    const state = new URL(signIn.url).searchParams.get('state') ?? '';
    // Another took the name while the person signed in.
    await w.signUp('work', 'bob');
    await expect(
      w.signIns.finish(BY, signIn.id, `http://127.0.0.1:1455/cb?state=${state}`),
    ).rejects.toMatchObject({ code: 'name_taken' });
    expect(w.ended).toEqual(['token-2']);
  });
});

describe('signing an account in again', () => {
  it('starts from its sign-in, and holds again once it is', async () => {
    const w = world();
    const account = await w.signUp('work');
    w.renewing.fails = new ModelFailure('The sign-in has ended', 'auth');
    w.later(HOUR);
    await expect(w.call(account.id)).rejects.toMatchObject({ kind: 'auth' });
    expect(await w.accounts.get(account.id)).toMatchObject({
      signIn: { signedOut: 'The sign-in has ended' },
    });
    // While it is signed out, no call is made, and nothing is renewed.
    await expect(w.call(account.id)).rejects.toThrow(/sign the account work in again/);
    expect(w.renewed).toHaveLength(1);

    const signIn = await w.signIns.start('plan', { account: account.id });
    expect(signIn.account).toBe(account.id);
    expect(w.started[1]?.again).toMatchObject({ accessToken: 'token-1' });
    const state = new URL(signIn.url).searchParams.get('state') ?? '';
    await expect(
      w.signIns.finish(BY, signIn.id, `http://127.0.0.1:1455/cb?state=${state}&who=bob`),
    ).rejects.toThrow(/another account/);
    const again = await w.signIns.finish(BY, signIn.id, `http://127.0.0.1:1455/cb?state=${state}`);
    expect(again).toMatchObject({ id: account.id, signIn: { email: 'alice@example.com' } });
    expect(again.signIn?.signedOut).toBeUndefined();
    await w.call(account.id);
    expect(w.calledWith.at(-1)).toBe('token-2');
  });

  it('is not of an account with a key', async () => {
    const w = world();
    const keyed = await w.accounts.add(BY, { provider: 'fake', name: 'key', apiKey: 'good' });
    await expect(w.signIns.start('plan', { account: keyed.id })).rejects.toThrow(
      /not signed in to/,
    );
  });
});

describe('a signed-in account’s token', () => {
  it('is used as it is while it lasts, and renewed shortly before it stops', async () => {
    const w = world();
    const account = await w.signUp('work');
    w.later(HOUR - 10 * 60 * 1000);
    await w.call(account.id);
    expect(w.renewed).toEqual([]);
    w.later(6 * 60 * 1000);
    await w.call(account.id);
    await w.call(account.id);
    expect(w.renewed).toEqual(['token-1']);
    expect(w.calledWith).toEqual(['token-1', 'token-2', 'token-2']);
  });

  it('is renewed once for calls that need it at the same time', async () => {
    const w = world();
    const account = await w.signUp('work');
    w.later(HOUR);
    let release = () => {};
    w.renewing.waits = new Promise((resolve) => {
      release = resolve;
    });
    const calls = [w.call(account.id), w.call(account.id), w.call(account.id)];
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await Promise.all(calls);
    expect(w.renewed).toEqual(['token-1']);
    expect(w.calledWith).toEqual(['token-2', 'token-2', 'token-2']);
  });

  it('is renewed, and the call made once more, when the provider refuses it early', async () => {
    const w = world();
    const account = await w.signUp('work');
    w.refused.add('token-1');
    await w.call(account.id);
    expect(w.calledWith).toEqual(['token-1', 'token-2']);
    // A token refused just after it was renewed is not renewed again.
    w.refused.add('token-2');
    w.later(HOUR);
    w.refused.add('token-3');
    await expect(w.call(account.id)).rejects.toMatchObject({ kind: 'auth' });
    expect(w.renewed).toEqual(['token-1', 'token-2']);
  });

  it('keeps the account’s sign-in when the provider could not be asked', async () => {
    const w = world();
    const account = await w.signUp('work');
    w.renewing.fails = new ModelFailure('down', 'network');
    w.later(HOUR);
    await expect(w.call(account.id)).rejects.toMatchObject({ kind: 'network' });
    expect((await w.accounts.get(account.id)).signIn?.signedOut).toBeUndefined();
    w.renewing.fails = undefined;
    await w.call(account.id);
    expect(w.calledWith).toEqual(['token-2']);
  });

  it('is not put back as it was by a change made while it was renewed', async () => {
    const w = world();
    const account = await w.signUp('work');
    w.later(HOUR);
    let release = () => {};
    w.renewing.waits = new Promise((resolve) => {
      release = resolve;
    });
    const call = w.call(account.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const renamed = w.accounts.update(BY, account.id, { name: 'renamed' });
    release();
    await Promise.all([call, renamed]);
    w.renewing.waits = undefined;
    await w.call(account.id);
    // The renewed token stayed: nothing was renewed again.
    expect(w.renewed).toEqual(['token-1']);
    expect(w.calledWith).toEqual(['token-2', 'token-2']);
    expect((await w.accounts.get(account.id)).name).toBe('renamed');
  });
});

describe('removing a signed-in account', () => {
  it('ends its sign-in at the provider', async () => {
    const w = world();
    const account = await w.signUp('work');
    await w.accounts.remove(BY, account.id);
    expect(w.ended).toEqual(['token-1']);
    expect(await w.accounts.list()).toEqual([]);
  });
});
