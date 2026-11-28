// Claude Code, the program, run for an account: each account has a folder of its own, which
// Claude Code is given as its home and its config. Claude Code keeps the account's sign-in
// there, and renews it; nothing here reads what it keeps.

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Where Claude Code is, and what it runs with. */
export type Program = {
  /** The `claude` program. */
  readonly binary: string;
  /** The folder the accounts' folders are in. */
  readonly accounts: string;
  /** The environment it is given what it needs of. */
  readonly env: { readonly [name: string]: string | undefined };
};

/** What Claude Code says of an account's sign-in. */
export type Status = {
  readonly loggedIn: boolean;
  readonly email?: string;
  /** Such as `max` or `pro`. */
  readonly plan?: string;
};

/** Claude Code could not be run, or did not answer as it does. */
export class ProgramFailed extends Error {
  override readonly name = 'ProgramFailed';
}

/** How long Claude Code is given to answer. */
const ANSWER_MS = 30_000;

/** What of the server's environment Claude Code is run with. No key or address of Anthropic's. */
const PASSED = ['PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ'];

/** An account's folder is named by letters, digits and dashes, and nothing that leaves the folder. */
const HOME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The folder of an account's Claude Code. */
export function folderOf(program: Program, home: string): string {
  if (!HOME.test(home)) throw new ProgramFailed(`${home} does not name an account's folder`);
  return join(program.accounts, home);
}

/** The environment Claude Code runs with for an account: its folder is its home and its config. */
export function envOf(program: Program, home: string): { [name: string]: string } {
  const folder = folderOf(program, home);
  const env: { [name: string]: string } = {};
  for (const name of PASSED) {
    const value = program.env[name];
    if (value !== undefined && value !== '') env[name] = value;
  }
  env['HOME'] = folder;
  env['CLAUDE_CONFIG_DIR'] = folder;
  return env;
}

/** Runs Claude Code for an account, with its folder made if it is not there. */
export function run(
  program: Program,
  home: string,
  args: readonly string[],
): ChildProcessWithoutNullStreams {
  const folder = folderOf(program, home);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  // There is no browser to open here: the person opens the link where they are.
  const env = { ...envOf(program, home), BROWSER: 'true' };
  return spawn(program.binary, args, { env, cwd: folder, stdio: ['pipe', 'pipe', 'pipe'] });
}

/** The end of what a process printed, for a person to read. */
export function lastLines(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/paste code/i.test(line))
    .slice(-3)
    .join(' ');
}

/** Runs Claude Code to its end, and gives what it printed. */
async function finished(child: ChildProcessWithoutNullStreams, what: string): Promise<string> {
  child.stdin.end();
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new ProgramFailed(`Claude Code did not ${what}`));
    }, ANSWER_MS);
    timer.unref();
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new ProgramFailed(`Claude Code could not be run: ${error.message}`));
    });
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return output;
}

/** What Claude Code says of an account's sign-in. */
export async function status(program: Program, home: string): Promise<Status> {
  const output = await finished(
    run(program, home, ['auth', 'status']),
    'say whether it is signed in',
  );
  let said: { loggedIn?: unknown; email?: unknown; subscriptionType?: unknown };
  try {
    said = JSON.parse(output) as typeof said;
  } catch {
    throw new ProgramFailed(
      `Claude Code did not say whether it is signed in: ${lastLines(output)}`,
    );
  }
  return {
    loggedIn: said.loggedIn === true,
    ...(typeof said.email === 'string' ? { email: said.email } : {}),
    ...(typeof said.subscriptionType === 'string' ? { plan: said.subscriptionType } : {}),
  };
}

/** Signs an account's Claude Code out, and removes its folder. */
export async function forget(program: Program, home: string): Promise<void> {
  const folder = folderOf(program, home);
  try {
    await finished(run(program, home, ['auth', 'logout']), 'sign out');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** The link to Claude's sign-in, as Claude Code prints it. */
const LINK = /https:\/\/\S+\/oauth\/authorize\?\S+/;

/** A `claude auth login` under way: its link, and the process that waits for the code. */
export class Login {
  readonly url: string;
  readonly #child: ChildProcessWithoutNullStreams;
  #output: string;
  readonly #exited: Promise<number | null>;

  private constructor(child: ChildProcessWithoutNullStreams, url: string, output: string) {
    this.#child = child;
    this.url = url;
    this.#output = output;
    this.#exited = new Promise((resolve) => {
      if (child.exitCode !== null) resolve(child.exitCode);
      else child.once('exit', (code) => resolve(code));
    });
    child.stdout.on('data', (chunk: Buffer) => (this.#output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (this.#output += chunk.toString('utf8')));
  }

  /** Starts Claude Code's sign-in for an account, and answers once it printed its link. */
  static async start(program: Program, home: string): Promise<Login> {
    const child = run(program, home, ['auth', 'login', '--claudeai']);
    let output = '';
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new ProgramFailed('Claude Code did not print a link to sign in with'));
      }, ANSWER_MS);
      timer.unref();
      // Answered once it asks for the code, so that what it prints later is what the code made it say.
      let link: string | undefined;
      let settle: ReturnType<typeof setTimeout> | undefined;
      const done = (): void => {
        clearTimeout(timer);
        if (settle !== undefined) clearTimeout(settle);
        child.stdout.off('data', read);
        child.removeListener('exit', ended);
        resolve(link ?? '');
      };
      const read = (chunk: Buffer): void => {
        output += chunk.toString('utf8');
        link ??= LINK.exec(output)?.[0];
        if (link === undefined) return;
        if (/paste code/i.test(output)) {
          done();
          return;
        }
        settle ??= setTimeout(done, 2_000);
      };
      const ended = (code: number | null): void => {
        clearTimeout(timer);
        reject(
          new ProgramFailed(
            lastLines(output) || `Claude Code ended (${String(code)}) before it printed a link`,
          ),
        );
      };
      child.stdout.on('data', read);
      child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(new ProgramFailed(`Claude Code could not be run: ${error.message}`));
      });
      child.once('exit', ended);
    });
    return new Login(child, url, output);
  }

  /**
   * Gives Claude Code the code Claude's page showed. True once it took it and kept the sign-in;
   * false when it asks for a code again, with what it said.
   */
  async enter(
    code: string,
  ): Promise<{ readonly taken: true } | { readonly taken: false; readonly said: string }> {
    const before = this.#output.length;
    this.#child.stdin.write(`${code.trim()}\n`);
    let look: (() => void) | undefined;
    const asked = new Promise<'asked'>((resolve) => {
      look = (): void => {
        if (/paste code/i.test(this.#output.slice(before))) resolve('asked');
      };
      this.#child.stdout.on('data', look);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), ANSWER_MS);
      timer.unref();
    });
    const outcome = await Promise.race([this.#exited, asked, late]);
    clearTimeout(timer);
    if (look !== undefined) this.#child.stdout.off('data', look);
    const said = lastLines(this.#output.slice(before));
    if (outcome === 0) return { taken: true };
    if (outcome === 'asked')
      return { taken: false, said: said || 'Claude Code did not take the code' };
    this.cancel();
    if (outcome === 'late')
      throw new ProgramFailed('Claude Code did not answer once it was given the code');
    throw new ProgramFailed(
      said || `Claude Code ended (${String(outcome)}) without keeping the sign-in`,
    );
  }

  /** Stops waiting for a code. */
  cancel(): void {
    if (this.#child.exitCode === null) this.#child.kill('SIGTERM');
  }
}
