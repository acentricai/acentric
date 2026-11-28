// Signing an account in to Claude with Claude Code's own `claude auth login`, on a stand-in of
// the program: the link it prints goes out, the code comes back in, and Claude Code keeps the
// sign-in in the account's folder.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SignInRefused } from '../src/provider.ts';
import type { SignInFlow } from '../src/provider.ts';
import { claudeProvider } from '../src/providers/claude/index.ts';
import { fakeProgram, fakeSdk } from './fake-claude.ts';

function flow(): { readonly signIn: SignInFlow; readonly dir: string } {
  const { binary, dir } = fakeProgram();
  const provider = claudeProvider({
    sdk: fakeSdk([]),
    binary,
    home: dir,
    env: { PATH: process.env['PATH'] },
  });
  if (provider.signIn === undefined) throw new Error('Claude has a sign-in');
  return { signIn: provider.signIn, dir };
}

describe('signing in to Claude', () => {
  it('answers the link Claude Code prints, and keeps the sign-in once it takes the code', async () => {
    const { signIn, dir } = flow();
    const started = await signIn.start({ host: 'urn:uuid:host' });
    expect(started.url).toMatch(/^https:\/\/claude\.ai\/oauth\/authorize\?z-\d+$/);
    const home = String(started.pending['home']);
    expect(home).toMatch(/^[0-9a-f-]{36}$/);
    expect(existsSync(join(dir, 'accounts', home))).toBe(true);

    const signedIn = await signIn.finish(started.pending, '  good-code \n', {});
    expect(signedIn).toEqual({
      credential: { type: 'local_sign_in', home },
      email: 'ada@example.test',
    });
    expect(existsSync(join(dir, 'accounts', home, 'signed-in'))).toBe(true);
    // Claude Code renews it itself.
    expect(await signIn.renew(signedIn.credential, {})).toEqual(signedIn.credential);
  });

  it('leaves a sign-in waiting when Claude does not take a code, for another to be given', async () => {
    const { signIn } = flow();
    const started = await signIn.start({ host: 'urn:uuid:host' });
    await expect(signIn.finish(started.pending, 'wrong-code', {})).rejects.toThrow(SignInRefused);
    await expect(signIn.finish(started.pending, 'wrong-code', {})).rejects.toThrow(
      /did not take that code/,
    );
    await expect(signIn.finish(started.pending, 'good-code', {})).resolves.toMatchObject({
      credential: { type: 'local_sign_in' },
    });
  });

  it('refuses an empty code, and a sign-in that no longer waits', async () => {
    const { signIn } = flow();
    const started = await signIn.start({ host: 'urn:uuid:host' });
    await expect(signIn.finish(started.pending, '  ', {})).rejects.toThrow(/Paste the code/);
    await signIn.finish(started.pending, 'good-code', {});
    await expect(signIn.finish(started.pending, 'good-code', {})).rejects.toThrow(
      /no longer waiting/,
    );
    await expect(signIn.finish({ id: 'other' }, 'good-code', {})).rejects.toThrow(SignInRefused);
  });

  it("gives up a new account's sign-in, and the folder it was in", async () => {
    const { signIn, dir } = flow();
    const started = await signIn.start({ host: 'urn:uuid:host' });
    const folder = join(dir, 'accounts', String(started.pending['home']));
    signIn.abandon?.(started.pending);
    await expect.poll(() => existsSync(folder)).toBe(false);
    await expect(signIn.finish(started.pending, 'good-code', {})).rejects.toThrow(
      /no longer waiting/,
    );
  });

  it('signs an account in again in its own folder, which giving it up leaves', async () => {
    const { signIn, dir } = flow();
    const first = await signIn.finish((await signIn.start({ host: 'h' })).pending, 'good-code', {});
    const again = await signIn.start({ host: 'h', again: first.credential });
    expect(again.pending['home']).toBe((first.credential as { home: string }).home);
    signIn.abandon?.(again.pending);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(join(dir, 'accounts', String(again.pending['home'])))).toBe(true);
  });

  it("ends a sign-in by signing Claude Code out, and removes the account's folder", async () => {
    const { signIn, dir } = flow();
    const { credential } = await signIn.finish(
      (await signIn.start({ host: 'h' })).pending,
      'good-code',
      {},
    );
    const home = (credential as { home: string }).home;
    await signIn.end(credential, {});
    expect(existsSync(join(dir, 'accounts', home))).toBe(false);
  });

  it('refuses a folder name that would leave the accounts folder', async () => {
    const { signIn } = flow();
    await expect(signIn.end({ type: 'local_sign_in', home: '../escape' }, {})).rejects.toThrow(
      /does not name/,
    );
  });
});
