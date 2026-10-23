// Starts a runner as a child process and talks to it over its stdin and
// stdout, for an application that embeds one. The runner lives as long as
// the connection: closing the client closes its stdin, and it stops
// gracefully.

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

import { lineSplitter, parseMessage } from '@acentric/protocol';

import { RunnerClient } from './client.js';
import type { ClientOptions, Transport } from './client.js';

export * from './index.js';

export type SpawnOptions = ClientOptions & {
  /** The runner's store, such as 'sqlite:./agents.db'. */
  store: string;
  /** The command that starts the runner. Defaults to `acentric-runner`. */
  command?: string;
  /** Arguments before the runner's own, such as a script for `node`. */
  args?: readonly string[];
  /** More arguments for the runner, such as `--secret OPENAI_API_KEY`. */
  runnerArgs?: readonly string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
};

export type SpawnedRunner = {
  client: RunnerClient;
  process: ChildProcess;
  /** Resolves with the exit code once the runner has exited. */
  exited: Promise<number | null>;
};

export async function spawnRunner(options: SpawnOptions): Promise<SpawnedRunner> {
  const child = spawn(
    options.command ?? 'acentric-runner',
    [
      ...(options.args ?? []),
      '--store',
      options.store,
      '--listen',
      'stdio',
      ...(options.runnerArgs ?? []),
    ],
    {
      stdio: ['pipe', 'pipe', 'inherit'],
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    },
  );
  const exited = new Promise<number | null>((resolve) =>
    child.once('exit', (code) => resolve(code)),
  );
  const { stdin, stdout } = child;
  if (stdin === null || stdout === null) throw new Error('the runner has no stdio');
  stdin.on('error', () => undefined);
  const transport: Transport = {
    send: (message) => {
      if (stdin.writable) stdin.write(`${JSON.stringify(message)}\n`);
    },
    receive: (handler) => {
      stdout.setEncoding('utf8');
      stdout.on(
        'data',
        lineSplitter((line) => handler(parseMessage(line))),
      );
    },
    closed: exited.then(() => undefined),
    close: () => stdin.end(),
  };
  const client = await RunnerClient.open(transport, options);
  return { client, process: child, exited };
}
