// acentric start: runs the local runner on a project's built bundles. It
// reads .env, passes the config's secrets to handlers, deploys every
// bundle (nothing changes for one already deployed), and serves the
// protocol on WebSocket, or on stdio for an application that started it.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  createLocalRunner,
  openStore,
  RunnerError,
  serveStreams,
  serveWebSocket,
} from '@acentric/runner-local';
import type { LocalRunner } from '@acentric/runner-local';

import type { Manifest } from './build.js';
import { resolveStore } from './config.js';
import type { Project } from './config.js';

export type StartOptions = {
  /** Serve the protocol on stdin and stdout instead of WebSocket. */
  stdio?: boolean;
  /** Overrides the config's `listen`. */
  listen?: string;
  /** Overrides the config's `store`. */
  store?: string;
  log?: (line: string) => void;
};

export type Started = {
  runner: LocalRunner;
  /** Where it listens, unless it serves stdio. */
  url: string | null;
  /** Resolves when a stdio connection ends; never, for WebSocket. */
  done: Promise<void>;
  /** Stops listening, lets running handlers finish, and closes the store. */
  close(): Promise<void>;
};

export class StartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartError';
  }
}

export async function startProject(project: Project, options: StartOptions = {}): Promise<Started> {
  const log = options.log ?? (() => undefined);
  const secrets = loadSecrets(project, log);

  const bundles = await Promise.all(project.agents.map((agent) => readBuilt(project, agent)));
  const store = await openStore(resolveStore(project.dir, options.store ?? project.store));
  let runner: LocalRunner;
  try {
    runner = createLocalRunner({ store, secrets, codeDir: join(project.dir, '.acentric', 'code') });
    await runner.start();
    for (const bundle of bundles) {
      // Deploying one bundle at a time keeps the log in order.
      // oxlint-disable-next-line no-await-in-loop
      const result = await deploy(runner, bundle);
      log(
        `${result.deployed ? 'deployed' : 'already deployed:'} ${bundle.manifest.name}@${bundle.manifest.version}`,
      );
    }
  } catch (error) {
    await store.close();
    throw error;
  }

  const stop = async (closeListener?: () => Promise<void>): Promise<void> => {
    await closeListener?.();
    await runner.close();
    await store.close();
  };

  if (options.stdio === true) {
    const done = serveStreams(runner, process.stdin, process.stdout);
    return { runner, url: null, done, close: () => stop() };
  }
  const listen = options.listen ?? project.listen;
  const where = /^ws:\/\/([^:/]+):(\d+)\/?$/.exec(listen);
  if (where === null) throw new StartError(`listen must be ws://HOST:PORT, not ${listen}`);
  const listener = await serveWebSocket(runner, {
    host: where[1] ?? '127.0.0.1',
    port: Number(where[2]),
  });
  log(`listening on ${listener.url}`);
  return {
    runner,
    url: listener.url,
    done: new Promise(() => undefined),
    close: () => stop(() => listener.close()),
  };
}

/** Reads the project's .env, then takes the config's secrets from the environment. */
export function loadSecrets(project: Project, log: (line: string) => void): Record<string, string> {
  const env = join(project.dir, '.env');
  if (existsSync(env)) process.loadEnvFile(env);
  const secrets: Record<string, string> = {};
  for (const name of project.secrets) {
    const value = process.env[name];
    if (value === undefined) log(`warning: secret ${name} is not set in the environment or .env`);
    else secrets[name] = value;
  }
  return secrets;
}

type Built = { manifest: Manifest; agent: string; handlers: string };

async function readBuilt(project: Project, agent: Project['agents'][number]): Promise<Built> {
  const dir = join(project.outDir, agent.name);
  const paths = ['manifest.json', 'agent.js', 'handlers.js'].map((file) => join(dir, file));
  if (!paths.every((path) => existsSync(path))) {
    throw new StartError(`${agent.name} is not built: run acentric build`);
  }
  const [manifestText, agentSource, handlersSource] = await Promise.all(
    paths.map((path) => readFile(path, 'utf8')),
  );
  const manifest = parseManifest(manifestText ?? '');
  if (manifest.version !== agent.version) {
    throw new StartError(
      `${agent.name} was built as ${manifest.version} but the config says ${agent.version}: run acentric build`,
    );
  }
  return { manifest, agent: agentSource ?? '', handlers: handlersSource ?? '' };
}

async function deploy(runner: LocalRunner, bundle: Built): Promise<{ deployed: boolean }> {
  try {
    return await runner.deploy({
      name: bundle.manifest.name,
      version: bundle.manifest.version,
      agent: bundle.agent,
      handlers: bundle.handlers,
      provides: bundle.manifest.provides,
    });
  } catch (error) {
    if (error instanceof RunnerError && error.code === 'bundle_conflict') {
      throw new StartError(
        `${bundle.manifest.name}@${bundle.manifest.version} is already deployed with different code: give the changed code a new version`,
      );
    }
    throw error;
  }
}

function parseManifest(text: string): Manifest {
  const value: unknown = JSON.parse(text);
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof Reflect.get(value, 'name') !== 'string' ||
    typeof Reflect.get(value, 'version') !== 'string'
  ) {
    throw new StartError('a manifest.json has no name and version: run acentric build');
  }
  // The manifest was written by acentric build in this shape.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as Manifest;
}
