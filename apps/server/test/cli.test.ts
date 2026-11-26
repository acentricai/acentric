// The acentric command, as a person gets it and uses it: installed from the engine with
// /install-cli.sh, signed in, a project started and deployed, a model account and a secret
// set, and an actor made and talked to. The server is the whole server, with an agent's real
// code in workerd. Only the model is a stand-in.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Providers, builtInProviders } from '@acentric/ai';
import type { ModelRunner } from '@acentric/ai';
import { calls, fakeProvider, says } from '@acentric/ai/testing';

import { readSettings, start } from '../src/index.ts';
import type { Started } from '../src/index.ts';

const REPO = join(import.meta.dirname, '..', '..', '..');
const ADMIN = 'the-key-this-engine-was-started-with';
const MODEL_KEY = 'a-key-the-fake-provider-takes';
/** The version the command says it is: the one its package has. */
const { version: VERSION } = JSON.parse(
  readFileSync(join(REPO, 'apps', 'cli', 'package.json'), 'utf8'),
) as { version: string };
const folders: string[] = [];
let downloads = '';

const folder = (): string => {
  const made = mkdtempSync(join(tmpdir(), 'acentric-cli-'));
  folders.push(made);
  return made;
};

/** A model that looks an order up when it is asked something, and says what it found. */
const model: ModelRunner = {
  async run(step) {
    const last = step.messages.at(-1);
    if (last?.role === 'tool_result') {
      return says(last.content.map((part) => (part.type === 'text' ? part.text : '')).join(''));
    }
    return calls({ id: 'call-1', name: 'lookup', arguments: { id: 4411 } });
  },
};

/** A server with what it hands out, on a folder of its own or one a server had before. */
const serve = (
  data: string,
  runner: ModelRunner = model,
  handsOut: string | null = downloads,
): Promise<Started> =>
  start(
    readSettings({
      ACENTRIC_PORT: '0',
      ACENTRIC_DATA: data,
      ACENTRIC_ADMIN_KEY: ADMIN,
      ACENTRIC_SECRET_KEY: 'ab'.repeat(32),
      ACENTRIC_CODE_PROCESSES: '1',
      ...(handsOut === null ? {} : { ACENTRIC_DOWNLOADS: handsOut }),
    }),
    {
      version: 'test',
      // The providers there are, so that a new project's agent deploys, and the one of tests.
      providers: new Providers([
        ...builtInProviders().list(),
        fakeProvider(runner, { keys: [MODEL_KEY] }),
      ]),
      log: () => {},
      checkAnswers: true,
    },
  );

beforeAll(() => {
  // What `pnpm build` made, in a folder as the server's image has it.
  const command = join(REPO, 'apps', 'cli', 'dist', 'acentric.mjs');
  if (!existsSync(command)) throw new Error(`${command} is not built: run \`pnpm build\``);
  downloads = folder();
  copyFileSync(join(REPO, 'apps', 'cli', 'install.sh'), join(downloads, 'install-cli.sh'));
  copyFileSync(command, join(downloads, 'acentric.mjs'));
  copyFileSync(join(REPO, 'apps', 'machine', 'install.sh'), join(downloads, 'install.sh'));
});

afterAll(() => {
  for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true });
});

type Ran = { readonly code: number | null; readonly out: string };
type Env = { readonly [name: string]: string };

/** Runs a shell command to its end, with what it is given on its input. */
function sh(command: string, env: Env, input = ''): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stdin.end(input);
    child.once('exit', (code) => {
      resolve({ code, out });
    });
  });
}

/** A person's own folder, with the command installed in it from a server. */
async function installed(url: string): Promise<{ env: Env; home: string; out: string }> {
  const home = folder();
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  const env = {
    HOME: home,
    PATH: `${join(home, '.local', 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`,
  };
  const ran = await sh(`curl -fsSL '${url}/install-cli.sh' | sh`, env);
  expect(ran.code, ran.out).toBe(0);
  return { env, home, out: ran.out };
}

/**
 * A project's packages as an install would leave them, made here with no network: the agent
 * package from the project's own vendor folder, and the repository's zod and esbuild.
 */
function installOffline(project: string): void {
  const modules = join(project, 'node_modules');
  mkdirSync(join(modules, '@acentric'), { recursive: true });
  symlinkSync(join(project, 'vendor', 'agent'), join(modules, '@acentric', 'agent'));
  symlinkSync(
    realpathSync(join(REPO, 'apps', 'server', 'node_modules', 'zod')),
    join(modules, 'zod'),
  );
  const esbuild = realpathSync(join(REPO, 'apps', 'cli', 'node_modules', 'esbuild'));
  symlinkSync(esbuild, join(modules, 'esbuild'));
  // esbuild finds its binary in the package beside it.
  symlinkSync(realpathSync(join(dirname(esbuild), '@esbuild')), join(modules, '@esbuild'));
}

/** An agent of the provider of tests, with a tool that reads a secret. */
const ORDERS = `import { Agent, tool } from '@acentric/agent';
import { z } from 'zod';

export default new Agent({
  provider: 'fake' as 'anthropic',
  instructions: 'You answer questions about orders.',
  tools: [
    tool({
      name: 'lookup',
      description: 'Finds an order.',
      parameters: z.object({ id: z.number() }),
      execute: async ({ id }, { secrets }) =>
        \`Order \${String(id)} was refunded twice. (asked with \${await secrets.get('ORDERS_API_KEY')})\`,
    }),
  ],
  secrets: ['ORDERS_API_KEY'],
});
`;

describe('the acentric command', () => {
  it('installs from the engine, signs in, starts a project, deploys it, and talks to an actor', async () => {
    const server = await serve(folder());
    const { url } = server.server;
    const { env, home, out } = await installed(url);
    expect(out).toContain(`from ${url}`);

    // The engine it was installed from is the one it signs in to, with the key given on its input.
    const login = await sh('acentric login', env, `${ADMIN}\n`);
    expect(login.out).toMatch(
      new RegExp(`Signed in to ${url} with the key \\S+, which reaches the whole engine\\.`),
    );
    const file = join(home, '.config', 'acentric', 'credentials.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ engine: url, key: ADMIN });

    // A project
    const work = folder();
    const init = await sh(`cd '${work}' && acentric init shop --agent support --no-install`, env);
    expect(init.code, init.out).toBe(0);
    const project = join(work, 'shop');
    expect(JSON.parse(readFileSync(join(project, 'acentric.json'), 'utf8'))).toEqual({
      agents: { support: 'agents/support.ts' },
    });
    const manifest = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')) as {
      dependencies: { [name: string]: string };
    };
    expect(manifest.dependencies['@acentric/agent']).toBe('file:./vendor/agent');
    expect(readFileSync(join(project, 'agents', 'support.ts'), 'utf8')).toContain(
      "import { Agent } from '@acentric/agent';",
    );
    // In another folder of the project, an agent is added where the command was run from.
    mkdirSync(join(project, 'packages', 'review'), { recursive: true });
    const added = await sh(
      `cd '${project}/packages/review' && acentric add reviewer --file agent.ts`,
      env,
    );
    expect(added.out).toContain('Added the agent reviewer, in packages/review/agent.ts.');
    installOffline(project);

    // The agent package it was given has its types: what an agent is written with is checked.
    const tsc = join(REPO, 'node_modules', '.bin', 'tsc');
    const checked = await sh(`cd '${project}' && '${tsc}' -p .`, env);
    expect(checked.code, checked.out).toBe(0);
    writeFileSync(
      join(project, 'agents', 'wrong.ts'),
      "import { Agent } from '@acentric/agent';\nexport default new Agent({ provider: 'anthropic', instructions: 42 });\n",
    );
    const wrong = await sh(`cd '${project}' && '${tsc}' -p .`, env);
    expect(wrong.code).not.toBe(0);
    expect(wrong.out).toContain('agents/wrong.ts');
    rmSync(join(project, 'agents', 'wrong.ts'));

    // Deploying
    const dry = await sh(`cd '${project}' && acentric deploy --dry-run`, env);
    expect(dry.out).toMatch(/support: bundled agents\/support\.ts, [\d.]+ KB/);
    const first = await sh(`cd '${project}/packages/review' && acentric deploy`, env);
    expect(first.code, first.out).toBe(0);
    expect(first.out).toMatch(/support: deployed as v1 \([\d.]+ KB\) · 0 tools · inputs message/);
    expect(first.out).toMatch(/reviewer: deployed as v1/);

    const orders = await sh(`cd '${project}' && acentric add orders`, env);
    expect(orders.out).toContain('Added the agent orders, in agents/orders.ts.');
    writeFileSync(join(project, 'agents', 'orders.ts'), ORDERS);
    const second = await sh(`cd '${project}' && acentric deploy`, env);
    expect(second.out).toContain('support: unchanged, still v1');
    expect(second.out).toMatch(/orders: deployed as v1 \([\d.]+ KB\) · 1 tools · inputs message/);
    expect(second.out).toContain(
      '  it reads secrets that are not set: ORDERS_API_KEY (`acentric secrets set orders <NAME>`)',
    );

    // A secret
    const set = await sh('acentric secrets set orders ORDERS_API_KEY', env, 'k-1\n');
    expect(set.out).toContain('Set ORDERS_API_KEY for the agent orders.');
    const secrets = await sh('acentric secrets orders', env);
    expect(secrets.out).toMatch(/NAME\s+SET\nORDERS_API_KEY\s+20\d\d-/);
    expect(secrets.out).not.toContain('k-1');
    const again = await sh(`cd '${project}' && acentric deploy orders`, env);
    expect(again.out.trim()).toBe('orders: unchanged, still v1');

    // A model account
    expect((await sh('acentric accounts', env)).out).toContain('The engine has no model account.');
    // Without one, no actor is made: it would have nothing to call its model with.
    const early = await sh('acentric actors create orders', env);
    expect(early.code).toBe(1);
    expect(early.out).toContain(
      'acentric: There is no model account for Fake: add one before creating an actor',
    );
    const refused = await sh('acentric accounts add fake main', env, 'not-a-key\n');
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('acentric: Fake refused the key');
    const account = await sh('acentric accounts add fake main', env, `${MODEL_KEY}\n`);
    expect(account.out).toContain('Added the account main of fake, its default.');
    const accounts = await sh('acentric accounts', env);
    expect(accounts.out).toMatch(
      /NAME\s+PROVIDER\s+DEFAULT\s+ACTORS\s+ID\nmain\s+fake\s+yes\s+0\s+acc_/,
    );
    expect(accounts.out).not.toContain(MODEL_KEY);

    // An actor
    const made = await sh('acentric actors create orders --name desk --account main', env);
    expect(made.out).toMatch(/Made the actor act_\w+ of orders v1, on fake-1\./);
    const [actor] = /act_\w+/.exec(made.out) ?? [];
    const talked = await sh('acentric actors send orders/desk Why two refunds? --follow', env);
    expect(talked.code, talked.out).toBe(0);
    expect(talked.out.trim().split('\n')).toEqual([
      '#1 user: Why two refunds?',
      '#2 assistant: → lookup({"id":4411})',
      // The agent's own code ran, in workerd, and read the secret that was set.
      '#3 lookup: Order 4411 was refunded twice. (asked with k-1)',
      '#4 assistant: Order 4411 was refunded twice. (asked with k-1)',
      '· idle (ok)',
    ]);
    const logs = await sh(`acentric actors logs ${String(actor)}`, env);
    expect(logs.out.trim().split('\n')).toEqual([
      ...talked.out.trim().split('\n').slice(0, 4),
      '· idle, its last turn ok',
    ]);
    const listed = await sh('acentric actors --agent orders', env);
    expect(listed.out).toMatch(/^ID\s+AGENT\s+NAME\s+STATUS\s+LAST TURN\n/);
    expect(listed.out).toMatch(
      new RegExp(`\\n${String(actor)}\\s+orders\\s+desk\\s+idle\\s+ok\\n`),
    );
    expect((await sh('acentric actors --agent support', env)).out).toContain(
      'The agent support has no actors.',
    );

    // An agent that uses Node fails where it is written, not at the engine; the others still go.
    writeFileSync(
      join(project, 'packages', 'review', 'agent.ts'),
      "import { readFileSync } from 'node:fs';\nexport default readFileSync;\n",
    );
    const broken = await sh(`cd '${project}' && acentric deploy`, env);
    expect(broken.code).toBe(1);
    expect(broken.out).toContain('support: unchanged, still v1');
    expect(broken.out).toMatch(
      /reviewer: packages\/review\/agent\.ts could not be bundled:\n {2}packages\/review\/agent\.ts:1:\d+: .*node:fs/,
    );
    expect(broken.out).toContain('acentric: reviewer was not deployed');
    const unknown = await sh(`cd '${project}' && acentric deploy nosuch`, env);
    expect(unknown.out).toContain('the project has no agent nosuch');

    // What was set is removed.
    expect((await sh('acentric secrets remove orders ORDERS_API_KEY', env)).out).toContain(
      'Removed ORDERS_API_KEY from the agent orders.',
    );
    expect((await sh('acentric secrets orders', env)).out).toContain(
      'The agent orders has no secrets.',
    );
    // An account an actor is given is kept while the actor is.
    const held = await sh('acentric accounts remove main', env);
    expect(held.code).toBe(1);
    expect(held.out).toContain('1 actor is given this account');
    await sh(`acentric actors delete ${String(actor)} --yes`, env);
    expect((await sh('acentric accounts remove main', env)).out).toContain(
      'Removed the account main of fake.',
    );

    const whoami = await sh('acentric whoami', env);
    expect(whoami.out).toMatch(
      new RegExp(`${url}, with the key \\S+, which reaches the whole engine`),
    );
    expect(whoami.out).toContain('It may: ');
    expect((await sh('acentric logout', env)).out).toContain('Signed out');
    const after = await sh(`cd '${project}' && acentric deploy support`, env);
    expect(after.out).toContain('acentric: not signed in to an engine');
    // As CI does: the engine and key from the environment, with nothing kept.
    const ci = await sh(`cd '${project}' && acentric deploy support`, {
      ...env,
      ENGINE_URL: url,
      ENGINE_API_KEY: ADMIN,
    });
    expect(ci.out).toContain('support: unchanged, still v1');
    await server.close();
  }, 180_000);

  it('refuses a key the engine does not take, and keeps nothing', async () => {
    const server = await serve(folder());
    const { env, home } = await installed(server.server.url);
    const refused = await sh(`'${home}/.acentric/bin/acentric' login`, env, 'not-a-key\n');
    expect(refused.code).toBe(1);
    expect(refused.out).toMatch(/acentric: .*key/i);
    expect(refused.out).toContain('sign in again: `acentric login`');
    expect((await sh('acentric whoami', env)).out).toContain('not signed in');
    // A command it has not, and an engine that is not there, are each said in a line.
    expect((await sh('acentric frobnicate', env)).out).toContain('there is no command frobnicate');
    await server.close();
    const gone = await sh('acentric whoami', {
      ...env,
      ENGINE_URL: server.server.url,
      ENGINE_API_KEY: ADMIN,
    });
    expect(gone.code).toBe(1);
    expect(gone.out).toMatch(/acentric: the engine at \S+ could not be reached/);
  }, 60_000);

  it('follows an actor through a server that is stopped in the middle of its turn', async () => {
    const data = folder();
    // The first call of the model never answers: the server is stopped while it waits.
    const first = await serve(data, { run: () => new Promise(() => {}) });
    const { env, home } = await installed(first.server.url);
    const with1 = { ...env, ENGINE_URL: first.server.url, ENGINE_API_KEY: ADMIN };
    const project = join(folder(), 'shop');
    await sh(`acentric init '${project}' --agent orders --no-install`, env);
    writeFileSync(join(project, 'agents', 'orders.ts'), ORDERS);
    installOffline(project);
    expect((await sh(`cd '${project}' && acentric deploy`, with1)).out).toContain('deployed as v1');
    await sh('acentric secrets set orders ORDERS_API_KEY --value k-1', with1);
    await sh(`acentric accounts add fake main --key ${MODEL_KEY}`, with1);
    const made = await sh('acentric actors create orders', with1);
    const [actor] = /act_\w+/.exec(made.out) ?? [];

    const talking = sh(`acentric actors send ${String(actor)} Why two refunds? --follow`, with1);
    await expect
      .poll(async () => (await sh(`acentric actors logs ${String(actor)}`, with1)).out)
      .toContain('· working');
    await first.close({ graceMs: 0 });
    const cut = await talking;
    expect(cut.code).toBe(1);
    expect(cut.out).toContain('#1 user: Why two refunds?');
    expect(cut.out).toContain('acentric: the engine stopped answering before the turn ended');

    // Started again on the same data, with a model that answers: the turn goes on by itself.
    const second = await serve(data);
    expect(second.recovered).toBe(1);
    const with2 = { ...env, ENGINE_URL: second.server.url, ENGINE_API_KEY: ADMIN };
    // Followed from where it is, until the person stops the command.
    const following = spawn(
      join(home, '.acentric', 'bin', 'acentric'),
      ['actors', 'logs', String(actor), '--follow'],
      { env: with2, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let followed = '';
    following.stdout.on('data', (chunk: Buffer) => (followed += chunk.toString()));
    following.stderr.on('data', (chunk: Buffer) => (followed += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => {
      following.once('exit', (code) => {
        resolve(code);
      });
    });
    await expect.poll(() => followed, { timeout: 20_000 }).toContain('· idle (ok)');
    expect(followed).toContain('#1 user: Why two refunds?');
    expect(followed).toContain('#4 assistant: Order 4411 was refunded twice. (asked with k-1)');
    following.kill('SIGINT');
    expect(await exited).toBe(0);
    const logs = await sh(`acentric actors logs ${String(actor)}`, with2);
    expect(logs.out).toContain('· idle, its last turn ok');
    await second.close();
  }, 120_000);
  it('is kept the engine’s own version: it says when they differ, and takes the engine’s', async () => {
    const first = await serve(folder());
    const { env, home } = await installed(first.server.url);
    const file = join(home, '.acentric', 'bin', 'acentric.mjs');
    const mine = readFileSync(file);
    const digest = (bytes: Uint8Array) =>
      createHash('sha256').update(bytes).digest('hex').slice(0, 12);

    // Not signed in, it is of the engine it was installed from.
    const same = await sh('acentric version', env);
    expect(same.out.trim().split('\n')).toEqual([
      `acentric ${VERSION} (${digest(mine)})`,
      `engine ${first.server.url}: test. It hands out this version of acentric.`,
    ]);
    expect((await sh('acentric update', env)).out).toContain(
      `This is the version the engine at ${first.server.url} hands out (${digest(mine)}).`,
    );
    await first.close();

    // An engine of another build: what it hands out is another file.
    const other = folder();
    copyFileSync(join(downloads, 'install-cli.sh'), join(other, 'install-cli.sh'));
    copyFileSync(join(downloads, 'install.sh'), join(other, 'install.sh'));
    const theirs = Buffer.concat([mine, Buffer.from('\n// another build\n')]);
    writeFileSync(join(other, 'acentric.mjs'), theirs);
    const second = await serve(folder(), model, other);
    const with2 = { ...env, ENGINE_URL: second.server.url, ENGINE_API_KEY: ADMIN };

    // Nobody is there to answer: a command does what it was asked, and nothing else.
    const used = await sh('acentric whoami', with2);
    expect(used.code, used.out).toBe(0);
    expect(used.out).not.toMatch(/different version|Update/);
    expect(readFileSync(file).equals(mine)).toBe(true);
    const differs = await sh('acentric version', with2);
    expect(differs.out).toContain(
      `engine ${second.server.url}: test. It hands out a different version of acentric (${digest(theirs)}): \`acentric update\` takes it.`,
    );

    const updated = await sh('acentric update', with2);
    expect(updated.code, updated.out).toBe(0);
    expect(updated.out).toContain(
      `Updated to the version the engine at ${second.server.url} hands out (${digest(mine)} → ${digest(theirs)}).`,
    );
    expect(readFileSync(file).equals(theirs)).toBe(true);
    // The command it now is runs, and is the engine's.
    expect((await sh('acentric version', with2)).out).toContain(
      'It hands out this version of acentric.',
    );
    await second.close();

    // An engine that hands out no command has none to take.
    const third = await serve(folder(), model, null);
    const with3 = { ...env, ENGINE_URL: third.server.url, ENGINE_API_KEY: ADMIN };
    const none = await sh('acentric update', with3);
    expect(none.code).toBe(1);
    expect(none.out).toContain('hands out no command (it answered 404)');
    expect((await sh('acentric version', with3)).out).toContain('It hands out no command.');
    expect(readFileSync(file).equals(theirs)).toBe(true);
    await third.close();
  }, 120_000);
});
