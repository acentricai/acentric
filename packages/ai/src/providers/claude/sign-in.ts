// Signing an account in to Claude, as Claude Code does on a machine with no browser: Claude
// Code prints a link to Claude's sign-in, the person signs in there and is shown a code, and
// the code is given back to Claude Code, which keeps the sign-in in the account's folder.
//
// Only Claude Code's own `claude auth login` is run, and only the link goes out and the code
// in. The account's credential names its folder, and nothing else.

import type { JsonObject } from '@acentric/protocol';

import { ModelFailure } from '../../failure.ts';
import { SignInRefused } from '../../provider.ts';
import type { Credential, SignInFlow } from '../../provider.ts';
import { Login, ProgramFailed, folderOf, forget, status } from './program.ts';
import type { Program } from './program.ts';

const PROVIDER = 'claude';

/** How long a sign-in that was started waits for its code. */
const WAITS_MS = 10 * 60 * 1000;

/** The folder an account signed in to Claude has, from its credential. */
export function homeOf(credential: Credential): string {
  if (credential.type !== 'local_sign_in') {
    throw new TypeError('Claude is called with a sign-in Claude Code keeps');
  }
  return credential.home;
}

/** Claude Code failed: Claude could not be asked. */
function unreachable(error: unknown): ModelFailure {
  const said = error instanceof Error ? error.message : String(error);
  return new ModelFailure(said, 'provider_error', { provider: PROVIDER });
}

/** Signing in to Claude with Claude Code, for accounts kept in `program`'s folder. */
export function claudeSignIn(program: Program): SignInFlow {
  /** The sign-ins that wait for their code, by the ID their `pending` names. */
  const waiting = new Map<
    string,
    { readonly login: Login; readonly home: string; readonly again: boolean }
  >();

  const drop = (id: string): void => {
    const one = waiting.get(id);
    if (one === undefined) return;
    waiting.delete(id);
    one.login.cancel();
    // What a new account's sign-in left is not kept: no account has its folder.
    if (!one.again) void forget(program, one.home).catch(() => undefined);
  };

  return {
    waitsMs: WAITS_MS,

    async start({ again }) {
      const home = again === undefined ? crypto.randomUUID() : homeOf(again);
      folderOf(program, home);
      let login: Login;
      try {
        login = await Login.start(program, home);
      } catch (error) {
        throw unreachable(error);
      }
      const id = crypto.randomUUID();
      waiting.set(id, { login, home, again: again !== undefined });
      // Given up once it can no longer be finished.
      setTimeout(() => drop(id), WAITS_MS + 60_000).unref();
      return { url: login.url, pending: { id, home } };
    },

    async finish(pending: JsonObject, returned: string) {
      const id = typeof pending['id'] === 'string' ? pending['id'] : '';
      const one = waiting.get(id);
      if (one === undefined) {
        throw new SignInRefused('This sign-in is no longer waiting for its code: start another');
      }
      const code = returned.trim();
      if (code === '') throw new SignInRefused('Paste the code Claude showed once you signed in');
      let entered;
      try {
        entered = await one.login.enter(code);
      } catch (error) {
        waiting.delete(id);
        throw error instanceof ProgramFailed ? unreachable(error) : error;
      }
      if (!entered.taken) throw new SignInRefused(`Claude did not take that code: ${entered.said}`);
      waiting.delete(id);
      let said;
      try {
        said = await status(program, one.home);
      } catch (error) {
        throw unreachable(error);
      }
      if (!said.loggedIn)
        throw new SignInRefused('Claude Code took the code, and is not signed in');
      return {
        credential: { type: 'local_sign_in', home: one.home },
        email: said.email ?? null,
      };
    },

    // Claude Code renews the sign-in itself.
    async renew(credential) {
      return credential;
    },

    async end(credential) {
      try {
        await forget(program, homeOf(credential));
      } catch (error) {
        throw unreachable(error);
      }
    },

    abandon(pending) {
      if (typeof pending['id'] === 'string') drop(pending['id']);
    },
  };
}
