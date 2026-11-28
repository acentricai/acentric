// Accounts whose sign-in a program of their provider keeps on the server itself, as Claude
// Code does: the account holds only the name of the program's folder, its calls are given the
// conversation's log, and it says it is signed out once its provider says so.

import { describe, expect, it } from 'vitest';

import { ModelFailure, Providers } from '@acentric/ai';
import type { Credential, ModelRunner, ModelStep, SessionLogs, SignInFlow } from '@acentric/ai';
import { fakeProvider, says } from '@acentric/ai/testing';
import type { Actor, JsonObject } from '@acentric/protocol';

import { Accounts } from '../src/accounts.ts';
import { Audit } from '../src/audit.ts';
import { MemoryStore } from '../src/memory-store.ts';
import { Secrets } from '../src/secrets.ts';
import { sessionLogs } from '../src/session-logs.ts';
import { SignIns } from '../src/sign-ins.ts';

const NOW = 1_795_305_600_000;
const BY = { type: 'system' } as const;

function world() {
  let now = NOW;
  const store = new MemoryStore();
  const audit = new Audit({ store, clock: () => now });
  const secrets = new Secrets({
    store,
    keys: { current: 'k1', keys: { k1: new Uint8Array(32).fill(1) } },
  });
  let folders = 0;
  const abandoned: JsonObject[] = [];
  const ended: Credential[] = [];
  const flow: SignInFlow = {
    waitsMs: 10 * 60 * 1000,
    async start({ again }) {
      folders += 1;
      const home = again?.type === 'local_sign_in' ? again.home : `home-${String(folders)}`;
      return { url: 'https://claude.ai/oauth/authorize?z-1', pending: { home } };
    },
    async finish(pending, code) {
      if (code !== 'good-code') throw new ModelFailure('unused', 'other');
      return {
        credential: { type: 'local_sign_in', home: String(pending['home']) },
        email: 'ada@example.com',
      };
    },
    async renew(credential) {
      return credential;
    },
    async end(credential) {
      ended.push(credential);
    },
    abandon(pending) {
      abandoned.push(pending);
    },
  };
  /** What each call was made with, and the homes whose program is signed out. */
  const calls: { home: string; logs: SessionLogs | undefined }[] = [];
  const signedOut = new Set<string>();
  const provider = {
    ...fakeProvider({ run: async () => says('unused') }),
    id: 'plan',
    label: 'Plan',
    credentials: ['local_sign_in'] as const,
    signIn: flow,
    runner: ({
      credential,
      logs,
    }: {
      credential: Credential;
      logs?: SessionLogs;
    }): ModelRunner => ({
      async run() {
        const home = credential.type === 'local_sign_in' ? credential.home : '';
        calls.push({ home, logs });
        if (signedOut.has(home)) throw new ModelFailure('Claude Code is not signed in', 'auth');
        return says('Hello.');
      },
    }),
  };
  const providers = new Providers([provider]);
  const accounts = new Accounts({ store, secrets, providers, audit, clock: () => now });
  const signIns = new SignIns({ store, providers, accounts, clock: () => now });
  const step: ModelStep = {
    model: 'fake-1',
    reasoning: 'low',
    instructions: '',
    tools: [],
    messages: [],
    session: 'act_1',
  };
  const signUp = async (name: string) => {
    const signIn = await signIns.start('plan', { name });
    return signIns.finish(BY, signIn.id, 'good-code');
  };
  const call = async (account: string) => {
    const { runner } = await accounts.access({ account } as Actor, 'plan');
    return runner.run(step, new AbortController().signal);
  };
  return {
    store,
    accounts,
    signIns,
    calls,
    signedOut,
    abandoned,
    ended,
    signUp,
    call,
    later: (ms: number) => {
      now += ms;
    },
  };
}

describe('an account whose sign-in its provider keeps', () => {
  it('is made by signing in, and holds only the name of its folder', async () => {
    const w = world();
    const account = await w.signUp('plan-1');
    expect(account).toMatchObject({
      provider: 'plan',
      credential: 'local_sign_in',
      signIn: { email: 'ada@example.com' },
      default: true,
    });
    await w.call(account.id);
    expect(w.calls.map((one) => one.home)).toEqual(['home-1']);
    // Its calls are given the conversation's log.
    expect(w.calls[0]?.logs).toBeTypeOf('function');
  });

  it('says it is signed out once its provider says so, and makes no call until it is signed in again', async () => {
    const w = world();
    const account = await w.signUp('plan-1');
    w.signedOut.add('home-1');
    await expect(w.call(account.id)).rejects.toMatchObject({ kind: 'auth' });
    expect((await w.accounts.get(account.id)).signIn).toEqual({
      email: 'ada@example.com',
      signedOut: 'Claude Code is not signed in',
    });
    const before = w.calls.length;
    await expect(w.call(account.id)).rejects.toThrow(/sign the account plan-1 in again/);
    expect(w.calls).toHaveLength(before);

    // Signed in again, in the same folder: it holds again.
    w.signedOut.delete('home-1');
    const again = await w.signIns.start('plan', { account: account.id });
    await w.signIns.finish(BY, again.id, 'good-code');
    expect((await w.accounts.get(account.id)).signIn).toEqual({ email: 'ada@example.com' });
    await expect(w.call(account.id)).resolves.toMatchObject({ stopReason: 'stop' });
    expect(w.calls.at(-1)?.home).toBe('home-1');
  });

  it('gives a sign-in that is given up or expires back to its provider', async () => {
    const w = world();
    const first = await w.signIns.start('plan', { name: 'one' });
    w.signIns.cancel(first.id);
    await w.signIns.start('plan', { name: 'two' });
    w.later(11 * 60 * 1000);
    await w.signIns.start('plan', { name: 'three' });
    expect(w.abandoned).toEqual([{ home: 'home-1' }, { home: 'home-2' }]);
  });

  it('ends its sign-in when it is removed', async () => {
    const w = world();
    const account = await w.signUp('plan-1');
    await w.accounts.remove(BY, account.id);
    expect(w.ended).toEqual([{ type: 'local_sign_in', home: 'home-1' }]);
  });
});

describe('the logs of conversations', () => {
  it("are kept in the store by the actor's ID, which is what a step names its conversation by", async () => {
    const store = new MemoryStore();
    const logs = sessionLogs(store);
    await logs('act_1').append('session', [{ sessionId: 's' }]);
    expect(await store.readSessionLog('act_1' as never, 'session')).toEqual([{ sessionId: 's' }]);
    expect(() => logs('conversation-1')).toThrow(/no actor's ID/);
  });
});
