// A server: the API listening on a port, over an engine. It is started from its parts, so a
// test can give it a model that calls no provider, and the program gives it the real ones.

import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { serve as listen } from '@hono/node-server';
import type { Accounts, Audit, Engine, Keys, People, Secrets } from '@acentric/core';
import { WebSocketServer } from 'ws';

import { createApp } from './app.ts';
import type { AppOptions } from './app.ts';
import type { Downloads } from './downloads.ts';
import { Streams } from './events.ts';
import type { BackupControl } from './backups/control.ts';
import type { UpdateCheck } from './updates.ts';
import type { UpdaterFolder } from './updater.ts';
import { takeDaemons } from './machines.ts';

export type ServerOptions = {
  readonly engine: Engine;
  readonly keys: Keys;
  readonly people: People;
  readonly audit: Audit;
  readonly secrets: Secrets;
  readonly accounts: Accounts;
  readonly backups?: BackupControl;
  readonly updates?: UpdateCheck;
  readonly updater?: UpdaterFolder;
  readonly version: string;
  /** 0 takes any free port. */
  readonly port: number;
  /** `127.0.0.1` without it: only this machine. */
  readonly host?: string;
  readonly report?: (error: unknown, requestId: string) => void;
  readonly checkAnswers?: boolean;
  readonly downloads?: Downloads;
  readonly answered?: NonNullable<AppOptions['answered']>;
  readonly ready?: NonNullable<AppOptions['ready']>;
};

export type Server = {
  /** Where it listens, such as `http://127.0.0.1:4000`. */
  readonly url: string;
  readonly port: number;
  /** How many actors' event streams are open now. */
  readonly streams: () => number;
  /**
   * Stops the server. It takes no new request, ends the streams that follow actors, and has
   * the engine finish what it is in the middle of, for `graceMs` at most.
   */
  close(options?: { readonly graceMs?: number }): Promise<void>;
};

export async function startServer(options: ServerOptions): Promise<Server> {
  const streams = new Streams();
  const app = createApp({ ...options, streams });
  const host = options.host ?? '127.0.0.1';
  const server = await new Promise<ReturnType<typeof listen>>((resolve, reject) => {
    const listening = listen({ fetch: app.fetch, port: options.port, hostname: host }, () => {
      resolve(listening);
    });
    listening.once('error', reject);
  });
  const { port } = server.address() as AddressInfo;
  // A connection that is quiet is kept for longer than what is in front keeps one (60 seconds
  // at AWS' load balancers, nginx's and others): a request is never sent on one this side has
  // just closed, which they answer with a 502. Headers are waited for a moment longer still.
  (server as HttpServer).keepAliveTimeout = 65_000;
  (server as HttpServer).headersTimeout = 66_000;
  // The machines' daemons connect here, each to stay.
  const daemons = new WebSocketServer({ noServer: true, maxPayload: 32 << 20 });
  if (options.engine.machines !== undefined) {
    takeDaemons(server as HttpServer, daemons, options.engine.machines);
  }
  let closing: Promise<void> | undefined;

  return {
    url: `http://${host.includes(':') ? `[${host}]` : host}:${String(port)}`,
    port,
    streams: () => streams.size,
    close(more = {}) {
      closing ??= (async () => {
        const closed = new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        });
        streams.close();
        // The engine drops the daemons' connections as it closes: no new one is taken.
        daemons.close();
        await options.engine.close(more);
        // A request that is still open after that is not waited for.
        (server as { closeAllConnections?: () => void }).closeAllConnections?.();
        await closed;
      })();
      return closing;
    },
  };
}
