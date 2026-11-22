#!/usr/bin/env node
// The acentric command.
//
// ENGINE_URL and ENGINE_API_KEY, when set, are used in place of the key `login` kept.

import { parseArgs } from 'node:util';
import type { ParseArgsOptionsConfig } from 'node:util';

import { add, deploy, init, login, logout, whoami } from './commands.ts';
import type { Io } from './engine.ts';
import { Fail } from './fail.ts';

const USAGE = `acentric: sign in to an engine, start a project of agents, and deploy them

  acentric login [engine] [--key <key>]   sign in to an engine, with one of its API keys
  acentric logout                         forget the key here
  acentric whoami                         the engine, and what the key may do

  acentric init [dir] [--agent <name>] [--no-install]
                                          start a project, with one agent
  acentric add <name> [--file <path>]     add an agent to the project
  acentric deploy [<name>...] [--dry-run] bundle the project's agents and deploy them`;

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
