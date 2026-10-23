#!/usr/bin/env node
// acentric: build a project's agents, start a runner with them, and inspect
// and drive a running runner.

import { parseArgs } from 'node:util';

import type { JsonObject } from '@acentric/types';

import { buildProject } from './build.js';
import { loadProject } from './config.js';
import { devProject } from './dev.js';
import * as inspect from './inspect.js';
import { startProject } from './start.js';

const USAGE = `usage: acentric <command> [options]

  dev [--port N]                 a dev runner: rebuilds and hot-reloads on save, with the dev UI
  build                          bundle the project's agents into .acentric/build
  start [--stdio]                run a runner with the built agents
  agents                         deployed agents
  ls                             sessions
  create <agent@version> [json]  create a session with a config
  send <id> <kind> [json]        send an input
  get <id> [--snapshot]          a session's status, view and running effects
  log <id> [-f] [--emits]        the log; -f follows it, --emits shows streamed text
  upgrade <id> <version>         move a session to another deployed version

options:
  -C, --dir DIR       the project (default: the current directory)
  --url URL           the runner to talk to (default: the project's listen, or ws://127.0.0.1:7420)
  --no-typecheck      build without type-checking
  --listen URL        where start listens
  --store SPEC        the store for start or dev: sqlite:./agents.db or fs:./agents
  --port N            dev: the port for the dev UI and the protocol
  --id ID             create: the session id
  --input-id ID       send: the input id, so a retry is answered as the first time
  --after N           log: start after this seq
  --json              log: one JSON entry per line`;

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
const err = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dir: { type: 'string', short: 'C', default: '.' },
      url: { type: 'string' },
      'no-typecheck': { type: 'boolean', default: false },
      stdio: { type: 'boolean', default: false },
      listen: { type: 'string' },
      store: { type: 'string' },
      id: { type: 'string' },
      'input-id': { type: 'string' },
      follow: { type: 'boolean', short: 'f', default: false },
      emits: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      after: { type: 'string', default: '0' },
      snapshot: { type: 'boolean', default: false },
      port: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || command === undefined) {
    out(USAGE);
    return values.help ? 0 : 2;
  }

  if (command === 'build') {
    const project = await loadProject(values.dir);
    const built = await buildProject(project, {
      ...(values['no-typecheck'] ? { typecheck: false } : {}),
      log: err,
    });
    for (const agent of built) {
      for (const warning of agent.warnings) err(`warning: ${warning}`);
      out(
        `${agent.manifest.name}@${agent.manifest.version}  ${agent.manifest.hash.slice(0, 12)}  ${agent.dir}`,
      );
    }
    return 0;
  }

  if (command === 'dev') {
    const project = await loadProject(values.dir);
    const dev = await devProject(project, {
      ...(values.port === undefined ? {} : { port: Number(values.port) }),
      ...(values.store === undefined ? {} : { store: values.store }),
      log: err,
    });
    out(`acentric dev: open ${dev.url}`);
    const stop = async (): Promise<void> => {
      err('stopping');
      await dev.close();
      process.exit(0);
    };
    process.once('SIGINT', () => void stop());
    process.once('SIGTERM', () => void stop());
    await new Promise(() => undefined);
    return 0;
  }

  if (command === 'start') {
    // With --stdio, stdout carries the protocol.
    if (values.stdio) console.log = console.error;
    const project = await loadProject(values.dir);
    const started = await startProject(project, {
      stdio: values.stdio,
      ...(values.listen === undefined ? {} : { listen: values.listen }),
      ...(values.store === undefined ? {} : { store: values.store }),
      log: err,
    });
    let stopping = false;
    const stop = async (): Promise<void> => {
      if (stopping) return;
      stopping = true;
      err('stopping');
      await started.close();
      process.exit(0);
    };
    process.once('SIGINT', () => void stop());
    process.once('SIGTERM', () => void stop());
    await started.done;
    await stop();
    return 0;
  }

  const url = values.url ?? (await projectUrl(values.dir));
  const need = (count: number, usage: string): string[] => {
    if (rest.length < count) throw new UsageError(`usage: acentric ${command} ${usage}`);
    return rest;
  };
  return inspect.withClient(url, async (client) => {
    switch (command) {
      case 'agents':
        await inspect.agents(client, out);
        return 0;
      case 'ls':
        await inspect.ls(client, out);
        return 0;
      case 'create': {
        const [agent = '', config] = need(1, '<agent@version> [config-json]');
        return (await inspect.create(client, out, agent, json(config, 'the config'), values.id))
          ? 0
          : 1;
      }
      case 'send': {
        const [id = '', kind = '', payload] = need(2, '<id> <kind> [payload-json]');
        return (await inspect.send(
          client,
          out,
          id,
          kind,
          json(payload, 'the payload'),
          values['input-id'],
        ))
          ? 0
          : 1;
      }
      case 'get': {
        const [id = ''] = need(1, '<id> [--snapshot]');
        await inspect.get(client, out, id, values.snapshot);
        return 0;
      }
      case 'log': {
        const [id = ''] = need(1, '<id> [-f] [--emits] [--json] [--after N]');
        await inspect.log(client, out, (text) => process.stdout.write(text), id, {
          follow: values.follow,
          emits: values.emits,
          json: values.json,
          after: Number(values.after),
        });
        return 0;
      }
      case 'upgrade': {
        const [id = '', version = ''] = need(2, '<id> <version>');
        return (await inspect.upgrade(client, out, id, version)) ? 0 : 1;
      }
      default:
        throw new UsageError(`unknown command ${command}\n\n${USAGE}`);
    }
  });
}

class UsageError extends Error {}

/** The project's listen address, or the default when there is no project here. */
async function projectUrl(dir: string): Promise<string> {
  try {
    return (await loadProject(dir)).listen;
  } catch {
    return 'ws://127.0.0.1:7420';
  }
}

function json(text: string | undefined, what: string): JsonObject {
  if (text === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new UsageError(`${what} is not JSON: ${text}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new UsageError(`${what} must be a JSON object`);
  }
  // Parsed from JSON text, so it is Json.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as JsonObject;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    err(`acentric: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(error instanceof UsageError ? 2 : 1);
  },
);
