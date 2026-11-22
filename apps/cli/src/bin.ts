#!/usr/bin/env node
// The acentric command.
//
// ENGINE_URL and ENGINE_API_KEY, when set, are used in place of the key `login` kept.

import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import type { ParseArgsOptionsConfig } from 'node:util';

import { addAccount, listAccounts, removeAccount } from './accounts.ts';
import { actorLogs, createActor, listActors, sendToActor } from './actors.ts';
import { add, deploy, init, login, logout, whoami } from './commands.ts';
import { readCredentials } from './credentials.ts';
import type { Io } from './engine.ts';
import { Fail } from './fail.ts';
import { listSecrets, removeSecret, setSecret } from './secrets.ts';
import { installedFile, offerUpdate, update, version } from './update.ts';

const USAGE = `acentric: sign in to an engine, start a project of agents, deploy them, and run them

  acentric login [engine] [--key <key>]   sign in to an engine, with one of its API keys
  acentric logout                         forget the key here
  acentric whoami                         the engine, and what the key may do

  acentric init [dir] [--agent <name>] [--no-install]
                                          start a project, with one agent
  acentric add <name> [--file <path>]     add an agent to the project
  acentric deploy [<name>...] [--dry-run] bundle the project's agents and deploy them

  acentric accounts                       the model accounts of the engine
  acentric accounts add <provider> <name> [--key <key>] [--default]
                                          add one: a key of a model provider's
  acentric accounts remove <name>         remove one that no agent is given

  acentric secrets <agent>                the names of an agent's secrets
  acentric secrets set <agent> <NAME> [--value <value>]
                                          set one, in place of what it was
  acentric secrets remove <agent> <NAME>  remove one

  acentric actors [--agent <agent>]       the actors of the engine, or of one agent
  acentric actors create <agent> [--name <name>] [--external-id <id>] [--model <model>]
                         [--reasoning <level>] [--configuration <json>]
                                          make an actor of an agent
  acentric actors send <actor> <text> [--follow]
  acentric actors send <actor> --type <type> --payload <json> [--follow]
                                          send an actor a message, or another input
  acentric actors logs <actor> [--follow] an actor's conversation, and as it grows

  acentric version                        this command's version, and the engine's
  acentric update                         take the version the engine hands out

An actor is named by its ID, or as <agent>/<name> when it has a name.`;

/** A secret from the terminal, not shown as it is typed; from what is piped in otherwise. */
async function secret(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    let text = '';
    for await (const chunk of input) text += String(chunk);
    return text.split('\n')[0] ?? '';
  }
  process.stderr.write(prompt);
  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let typed = '';
    const done = (value: string | Error) => {
      input.setRawMode(false);
      input.pause();
      input.off('data', onData);
      process.stderr.write('\n');
      if (value instanceof Error) reject(value);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          done(typed);
          return;
        }
        if (char === '\u0003') {
          done(new Fail('stopped'));
          return;
        }
        if (char === '\u007F' || char === '\b') typed = typed.slice(0, -1);
        else typed += char;
      }
    };
    input.on('data', onData);
  });
}

/** Asks a person yes or no. Nothing but a no is a no. */
async function confirm(question: string): Promise<boolean> {
  const lines = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await lines.question(question)).trim().toLowerCase();
    return answer !== 'n' && answer !== 'no';
  } finally {
    lines.close();
  }
}

/** The engine a command is of: the one signed in to, or the one it was installed from. */
function engineOf(io: Io): string | undefined {
  const installedFrom = io.env['ACENTRIC_ENGINE'];
  return (
    readCredentials(io.env)?.engine ??
    (installedFrom === undefined || installedFrom === '' ? undefined : installedFrom)
  );
}

type Options = ParseArgsOptionsConfig;

/** The value of an option that takes one. */
const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

async function main(argv: readonly string[], signal: AbortSignal): Promise<void> {
  const [command, ...rest] = argv;
  const io: Io = {
    cwd: process.cwd(),
    env: process.env,
    out: (line) => {
      console.log(line);
    },
    secret,
    signal,
  };
  const args = (options: Options, from: readonly string[] = rest) =>
    parseArgs({ args: [...from], options, allowPositionals: true });
  /** The positionals of a command that takes exactly so many, each said by what it is. */
  const exactly = (given: readonly string[], what: readonly string[], usage: string): string[] => {
    if (given.length !== what.length) throw new Fail(`${usage} takes ${what.join(' and ')}`);
    return [...given];
  };

  switch (command) {
    case 'login': {
      const { values, positionals } = args({ key: { type: 'string' } });
      if (positionals.length > 1) throw new Fail('login takes one engine address');
      return login(io, { url: positionals[0], key: text(values['key']) });
    }
    case 'logout':
      logout(io);
      return;
    case 'whoami':
      return whoami(io);
    case 'init': {
      const { values, positionals } = args({
        agent: { type: 'string' },
        'no-install': { type: 'boolean' },
      });
      if (positionals.length > 1) throw new Fail('init takes one folder');
      init(io, {
        dir: positionals[0],
        agent: text(values['agent']),
        install: values['no-install'] !== true,
      });
      return;
    }
    case 'add': {
      const { values, positionals } = args({ file: { type: 'string' } });
      const [agent] = exactly(positionals, ['the name of the agent to add'], 'add');
      add(io, { agent: agent ?? '', file: text(values['file']) });
      return;
    }
    case 'deploy': {
      const { values, positionals } = args({ 'dry-run': { type: 'boolean' } });
      return deploy(io, { agents: positionals, dryRun: values['dry-run'] === true });
    }

    case 'accounts': {
      const [sub, ...more] = rest;
      if (sub === 'add') {
        const { values, positionals } = args(
          { key: { type: 'string' }, default: { type: 'boolean' } },
          more,
        );
        const [provider, name] = exactly(
          positionals,
          ['a provider', 'a name for the account'],
          'accounts add',
        );
        return addAccount(io, {
          provider: provider ?? '',
          name: name ?? '',
          key: text(values['key']),
          default: values['default'] === true,
        });
      }
      if (sub === 'remove') {
        const [account] = exactly(args({}, more).positionals, ['the account'], 'accounts remove');
        return removeAccount(io, { account: account ?? '' });
      }
      if (sub === undefined || sub === 'list') return listAccounts(io);
      throw new Fail(`accounts has no ${sub}`, 'see `acentric help`');
    }

    case 'secrets': {
      const [sub, ...more] = rest;
      if (sub === 'set') {
        const { values, positionals } = args({ value: { type: 'string' } }, more);
        const [agent, name] = exactly(
          positionals,
          ['an agent', 'the name of the secret'],
          'secrets set',
        );
        return setSecret(io, {
          agent: agent ?? '',
          name: name ?? '',
          value: text(values['value']),
        });
      }
      if (sub === 'remove') {
        const [agent, name] = exactly(
          args({}, more).positionals,
          ['an agent', 'the name of the secret'],
          'secrets remove',
        );
        return removeSecret(io, { agent: agent ?? '', name: name ?? '' });
      }
      // `secrets <agent>` and `secrets list <agent>` are the same.
      const [agent] = exactly(
        args({}, sub === 'list' ? more : rest).positionals,
        ['an agent'],
        'secrets',
      );
      return listSecrets(io, { agent: agent ?? '' });
    }

    case 'actors': {
      const [sub, ...more] = rest;
      if (sub === 'create') {
        const { values, positionals } = args(
          {
            name: { type: 'string' },
            'external-id': { type: 'string' },
            model: { type: 'string' },
            reasoning: { type: 'string' },
            configuration: { type: 'string' },
          },
          more,
        );
        const [agent] = exactly(positionals, ['an agent'], 'actors create');
        return createActor(io, {
          agent: agent ?? '',
          name: text(values['name']),
          externalId: text(values['external-id']),
          model: text(values['model']),
          reasoning: text(values['reasoning']),
          configuration: text(values['configuration']),
        });
      }
      if (sub === 'send') {
        const { values, positionals } = args(
          {
            type: { type: 'string' },
            payload: { type: 'string' },
            follow: { type: 'boolean', short: 'f' },
          },
          more,
        );
        const [actor, ...words] = positionals;
        if (actor === undefined) throw new Fail('actors send takes an actor, and what to send it');
        return sendToActor(io, {
          actor,
          text: words.length === 0 ? undefined : words.join(' '),
          type: text(values['type']) ?? 'message',
          payload: text(values['payload']),
          follow: values['follow'] === true,
        });
      }
      if (sub === 'logs') {
        const { values, positionals } = args({ follow: { type: 'boolean', short: 'f' } }, more);
        const [actor] = exactly(positionals, ['an actor'], 'actors logs');
        return actorLogs(io, { actor: actor ?? '', follow: values['follow'] === true });
      }
      if (sub === undefined || sub === 'list' || sub.startsWith('-')) {
        const { values, positionals } = args(
          { agent: { type: 'string' } },
          sub === 'list' ? more : rest,
        );
        if (positionals.length > 0) throw new Fail('actors takes `--agent <agent>`, or nothing');
        return listActors(io, { agent: text(values['agent']) });
      }
      throw new Fail(`actors has no ${sub}`, 'see `acentric help`');
    }

    case 'version':
    case '--version':
      return version(io, { file: installedFile(), engine: engineOf(io) });
    case 'update': {
      const file = installedFile();
      const engine = engineOf(io);
      if (file === undefined) {
        throw new Fail(
          'this command was not installed from an engine, and is not updated from one',
          'install it with `curl -fsSL <engine>/install-cli.sh | sh`',
        );
      }
      if (engine === undefined) {
        throw new Fail('say which engine: sign in with `acentric login <engine address>`');
      }
      await update(io, { file, engine });
      return;
    }

    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return;
    default:
      throw new Fail(`there is no command ${command}`, 'see `acentric help`');
  }
}

// Stopped by the person: what is being followed ends, and the command with it.
const stopping = new AbortController();
process.once('SIGINT', () => {
  stopping.abort();
});

const [asked] = process.argv.slice(2);
try {
  await main(process.argv.slice(2), stopping.signal);
} catch (error) {
  if (error instanceof Fail) {
    console.error(`acentric: ${error.message}`);
    if (error.hint !== undefined) console.error(`  ${error.hint}`);
  } else if (
    error instanceof TypeError &&
    (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS') === true
  ) {
    console.error(`acentric: ${error.message}`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
}

// After what was asked for: the engine's version of the command is offered when it has
// another, to a person who is there to answer. Never after the commands that are about it.
if (
  asked !== 'update' &&
  asked !== 'version' &&
  asked !== '--version' &&
  !stopping.signal.aborted
) {
  try {
    await offerUpdate(
      {
        env: process.env,
        out: (line) => {
          console.error(line);
        },
        ...(process.stdin.isTTY && process.stderr.isTTY ? { confirm } : {}),
      },
      installedFile(),
    );
  } catch (error) {
    // What was asked for is done, or has failed for its own reasons: this does not change it.
    console.error(`acentric: ${error instanceof Error ? error.message : String(error)}`);
  }
}
