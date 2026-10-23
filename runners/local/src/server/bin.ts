#!/usr/bin/env node
// acentric-runner: the local runner as a process applications talk to.
//
//   acentric-runner --store sqlite:./agents.db [--listen stdio | ws://127.0.0.1:7420]
//                   [--code-dir DIR] [--secret NAME]... [--host-import MODULE]...
//                   [--grace-ms N] [--idle-ms N] [--timeout-ms N] [--max-attempts N]
//
// Over stdio, the runner lives as long as its input: when stdin closes, it
// stops gracefully. Over WebSocket, it runs until SIGINT or SIGTERM. Stdout
// carries only the protocol: console output, the runner's own and its
// handlers', goes to stderr.

import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { createLocalRunner } from '../runner.js';
import { openSqliteStore } from '../store/sqlite.js';
import type { Store } from '../store/types.js';
import { serveStreams, serveWebSocket } from './transports.js';

// Stdout is the protocol.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

const USAGE = `usage: acentric-runner --store sqlite:PATH [--listen stdio|ws://HOST:PORT]
  [--code-dir DIR] [--secret NAME]... [--host-import MODULE]...
  [--grace-ms N] [--idle-ms N] [--timeout-ms N] [--max-attempts N]`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      store: { type: 'string' },
      listen: { type: 'string', default: 'stdio' },
      'code-dir': { type: 'string' },
      secret: { type: 'string', multiple: true, default: [] },
      'host-import': { type: 'string', multiple: true, default: [] },
      'grace-ms': { type: 'string' },
      'idle-ms': { type: 'string' },
      'timeout-ms': { type: 'string' },
      'max-attempts': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help || values.store === undefined) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(values.help ? 0 : 2);
  }
  const store = await openStore(values.store);
  const secrets: Record<string, string> = {};
  for (const name of values.secret) {
    const value = process.env[name];
    if (value === undefined) fail(`--secret ${name}: the environment has no ${name}`);
    secrets[name] = value;
  }
  const execArgv = values['host-import'].flatMap((module) => ['--import', moduleUrl(module)]);
  const runner = createLocalRunner({
    store,
    secrets,
    ...(values['code-dir'] === undefined ? {} : { codeDir: values['code-dir'] }),
    ...number('graceMs', values['grace-ms']),
    ...number('idleMs', values['idle-ms']),
    ...number('timeoutMs', values['timeout-ms']),
    ...number('maxAttempts', values['max-attempts']),
    host: { execArgv },
  });
  await runner.start();

  let stopping: Promise<void> | null = null;
  const stop = (close?: () => Promise<void>): Promise<void> => {
    stopping ??= (async () => {
      await close?.();
      await runner.close();
      await store.close();
      process.exit(0);
    })();
    return stopping;
  };

  if (values.listen === 'stdio') {
    process.once('SIGTERM', () => void stop());
    process.once('SIGINT', () => void stop());
    await serveStreams(runner, process.stdin, process.stdout);
    await stop();
    return;
  }
  const where = /^ws:\/\/([^:/]+):(\d+)\/?$/.exec(values.listen);
  if (where === null) fail(`--listen must be stdio or ws://HOST:PORT, not ${values.listen}`);
  const listener = await serveWebSocket(runner, {
    host: where[1] ?? '127.0.0.1',
    port: Number(where[2]),
  });
  process.stderr.write(`acentric-runner listening on ${listener.url}\n`);
  const closeListener = (): Promise<void> => listener.close();
  process.once('SIGTERM', () => void stop(closeListener));
  process.once('SIGINT', () => void stop(closeListener));
}

function openStore(spec: string): Promise<Store> {
  const sqlite = /^sqlite:(.+)$/.exec(spec);
  if (sqlite?.[1] === undefined) fail(`--store must be sqlite:PATH, not ${spec}`);
  return openSqliteStore(sqlite[1]);
}

function number(name: string, value: string | undefined): Record<string, number> {
  if (value === undefined) return {};
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) fail(`--${name} must be a number`);
  return { [name]: parsed };
}

/** A module for `--import`: a package name or URL as it is, a path as a file URL. */
function moduleUrl(module: string): string {
  return module.startsWith('.') || module.startsWith('/') ? pathToFileURL(module).href : module;
}

function fail(message: string): never {
  process.stderr.write(`acentric-runner: ${message}\n${USAGE}\n`);
  process.exit(2);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `acentric-runner: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
