// A server: the API listening on a port, over an engine. It is started from its parts, so a
// test can give it a model that calls no provider, and the program gives it the real ones.

import type { AddressInfo } from 'node:net';

import { serve as listen } from '@hono/node-server';
import type { Audit, Engine, Keys, People, Secrets } from '@acentric/core';

import { createApp } from './app.ts';
import { Streams } from './events.ts';

export type ServerOptions = {
  readonly engine: Engine;
  readonly keys: Keys;
  readonly people: People;
  readonly audit: Audit;
  readonly secrets: Secrets;
  readonly version: string;
  /** 0 takes any free port. */
  readonly port: number;
  /** `127.0.0.1` without it: only this machine. */
  readonly host?: string;
  readonly report?: (error: unknown, requestId: string) => void;
  readonly checkAnswers?: boolean;
};

export type Server = {
  /** Where it listens, such as `http://127.0.0.1:4000`. */
  readonly url: string;
  readonly port: number;
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
  let closing: Promise<void> | undefined;

  return {
    url: `http://${host.includes(':') ? `[${host}]` : host}:${String(port)}`,
    port,
    close(more = {}) {
      closing ??= (async () => {
        const closed = new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        });
        streams.close();
        await options.engine.close(more);
        // A request that is still open after that is not waited for.
        (server as { closeAllConnections?: () => void }).closeAllConnections?.();
        await closed;
      })();
      return closing;
    },
  };
}
