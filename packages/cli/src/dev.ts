// acentric dev: a runner for working on a project's agents. It builds each
// agent and deploys it as <version>-dev.<hash>, then watches the project:
// on every save it builds again, deploys the new code under a new dev
// version and upgrades the agent's instances to it, keeping their state
// through migrate. Hot reload is an upgrade, so an instance faulted by a bug
// is fixed by saving the fix: the upgrade clears the fault and the message
// that failed is stepped again on the new code. A build that fails leaves
// instances on the code they had.
//
// One port serves the protocol over WebSocket, the dev UI, and the dev
// events the UI shows: builds, deploys and upgrades.

import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

import type { Answer } from '@acentric/protocol';
import { createLocalRunner, openStore, serveWebSocket } from '@acentric/runner-local';
import type { LocalRunner } from '@acentric/runner-local';

import { buildAgent } from './build.js';
import { resolveStore } from './config.js';
import type { Project } from './config.js';
import { loadSecrets } from './start.js';
import { PAGE } from './ui/page.js';

/** What happened in dev, for the terminal and the dev UI. */
export type DevEvent =
  | { type: 'building'; at: number; agent: string }
  | {
      type: 'built';
      at: number;
      agent: string;
      version: string;
      deployed: boolean;
      warnings: string[];
    }
  | { type: 'build_failed'; at: number; agent: string; error: string }
  | {
      type: 'upgraded';
      at: number;
      agent: string;
      instance: string;
      from: string;
      to: string;
      answer: Answer;
    };

export type DevOptions = {
  host?: string;
  /** Defaults to the port of the project's `listen`. 0 picks a free one. */
  port?: number;
  /** Defaults to sqlite:.acentric/dev.db, apart from the store `acentric start` uses. */
  store?: string;
  log?: (line: string) => void;
};

export type DevServer = {
  runner: LocalRunner;
  /** The dev UI, over HTTP. */
  url: string;
  /** The protocol, over WebSocket. */
  wsUrl: string;
  /** The dev version each agent runs now. */
  versions(): Record<string, string>;
  /** Builds and deploys every agent again, as a save does. */
  rebuild(): Promise<void>;
  /** Resolves with the next event that passes `test`. */
  next(test: (event: DevEvent) => boolean): Promise<DevEvent>;
  close(): Promise<void>;
};

const KEPT_EVENTS = 200;
/** Folders whose changes never need a rebuild. */
const IGNORED = new Set(['node_modules', '.acentric', '.git', 'dist']);

export async function devProject(project: Project, options: DevOptions = {}): Promise<DevServer> {
  const log = options.log ?? (() => undefined);
  const secrets = loadSecrets(project, log);
  const store = await openStore(
    resolveStore(project.dir, options.store ?? 'sqlite:.acentric/dev.db'),
  );
  const runner = createLocalRunner({
    store,
    secrets,
    codeDir: join(project.dir, '.acentric', 'code'),
  });
  await runner.start();

  const versions: Record<string, string> = {};
  const events: DevEvent[] = [];
  const streams = new Set<ServerResponse>();
  const waiters = new Set<{
    test: (event: DevEvent) => boolean;
    resolve: (event: DevEvent) => void;
  }>();

  const emit = (event: DevEvent): void => {
    events.push(event);
    if (events.length > KEPT_EVENTS) events.shift();
    log(describe(event));
    for (const stream of streams) stream.write(`data: ${JSON.stringify(event)}\n\n`);
    for (const waiter of waiters) {
      if (waiter.test(event)) {
        waiters.delete(waiter);
        waiter.resolve(event);
      }
    }
  };

  const devOut = join(project.dir, '.acentric', 'dev-build');
  const rebuildAgent = async (agent: Project['agents'][number]): Promise<void> => {
    emit({ type: 'building', at: Date.now(), agent: agent.name });
    let version: string;
    let deployed: boolean;
    let warnings: string[];
    try {
      const built = await buildAgent({ ...project, outDir: devOut }, agent);
      const [agentSource, handlersSource] = await Promise.all([
        readFile(join(built.dir, 'agent.js'), 'utf8'),
        readFile(join(built.dir, 'handlers.js'), 'utf8'),
      ]);
      const hash = createHash('sha256')
        .update(JSON.stringify([agentSource, handlersSource, agent.provides]))
        .digest('hex')
        .slice(0, 12);
      version = `${agent.version}-dev.${hash}`;
      deployed = (
        await runner.deploy({
          name: agent.name,
          version,
          agent: agentSource,
          handlers: handlersSource,
          provides: agent.provides,
        })
      ).deployed;
      warnings = built.warnings;
    } catch (error) {
      emit({
        type: 'build_failed',
        at: Date.now(),
        agent: agent.name,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    versions[agent.name] = version;
    emit({ type: 'built', at: Date.now(), agent: agent.name, version, deployed, warnings });
    for (const instance of await runner.list({ agent: agent.name })) {
      if (instance.agent.version === version) continue;
      // Upgrading one instance at a time keeps their events in order.
      // oxlint-disable-next-line no-await-in-loop
      const answer = await runner.upgrade(instance.id, version).catch((error: unknown): Answer => ({
        failed: error instanceof Error ? error.message : String(error),
      }));
      emit({
        type: 'upgraded',
        at: Date.now(),
        agent: agent.name,
        instance: instance.id,
        from: instance.agent.version,
        to: version,
        answer,
      });
    }
    for (const bundle of await runner.listAgents()) {
      if (
        bundle.name === agent.name &&
        bundle.version !== version &&
        bundle.version.includes('-dev.') &&
        bundle.instances === 0
      ) {
        // Old dev versions no instance uses are removed one by one.
        // oxlint-disable-next-line no-await-in-loop
        await runner.undeploy(bundle).catch(() => undefined);
      }
    }
  };

  let queue: Promise<void> = Promise.resolve();
  const rebuild = (): Promise<void> => {
    queue = queue.then(async () => {
      for (const agent of project.agents) {
        // Agents are rebuilt one after another.
        // oxlint-disable-next-line no-await-in-loop
        await rebuildAgent(agent);
      }
    });
    return queue;
  };
  await rebuild();

  let timer: ReturnType<typeof setTimeout> | null = null;
  const watcher: FSWatcher = watch(project.dir, { recursive: true }, (_event, file) => {
    if (
      file === null ||
      relative(project.dir, join(project.dir, file))
        .split(sep)
        .some((part) => IGNORED.has(part))
    ) {
      return;
    }
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void rebuild();
    }, 120);
  });

  const ui = bundleUi();
  const server = createServer((request, response) => {
    void route(request, response).catch((error: unknown) => {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(PAGE);
    } else if (path === '/app.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      response.end(await ui);
    } else if (path === '/dev/state') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ project: project.dir, versions, events }));
    } else if (path === '/dev/events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      response.write(': connected\n\n');
      streams.add(response);
      request.once('close', () => streams.delete(response));
    } else {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
    }
  };
  const ws = await serveWebSocket(runner, { server });
  const host = options.host ?? listenHost(project.listen);
  const port = options.port ?? listenPort(project.listen);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const bound = typeof address === 'object' && address !== null ? address.port : port;
  const url = `http://${host}:${bound}`;
  log(`dev UI on ${url}; protocol on ws://${host}:${bound}`);

  return {
    runner,
    url,
    wsUrl: `ws://${host}:${bound}`,
    versions: () => ({ ...versions }),
    rebuild,
    next: (test) => new Promise((resolve) => waiters.add({ test, resolve })),
    close: async () => {
      watcher.close();
      if (timer !== null) clearTimeout(timer);
      await queue.catch(() => undefined);
      for (const stream of streams) stream.end();
      await ws.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runner.close();
      await store.close();
    },
  };
}

/** The dev UI's script: its module and @acentric/client, bundled for the browser. */
async function bundleUi(): Promise<string> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./ui/app.js', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  return result.outputFiles[0]?.text ?? '';
}

function describe(event: DevEvent): string {
  switch (event.type) {
    case 'building':
      return `building ${event.agent}`;
    case 'built':
      return `${event.deployed ? 'deployed' : 'unchanged:'} ${event.agent}@${event.version}${event.warnings.map((warning) => `\n  warning: ${warning}`).join('')}`;
    case 'build_failed':
      return `build of ${event.agent} failed, instances keep the code they had:\n${event.error}`;
    case 'upgraded':
      return 'accepted' in event.answer
        ? `upgraded ${event.instance} to ${event.to}`
        : `could not upgrade ${event.instance} to ${event.to}, it stays on ${event.from}: ${JSON.stringify(event.answer)}`;
  }
}

function listenHost(listen: string): string {
  return /^ws:\/\/([^:/]+):/.exec(listen)?.[1] ?? '127.0.0.1';
}

function listenPort(listen: string): number {
  return Number(/:(\d+)\/?$/.exec(listen)?.[1] ?? 7420);
}
