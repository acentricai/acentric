// The protocol's transports: one JSON message per line on a pair of
// streams, such as stdin and stdout, or one per WebSocket frame.

import type { Server as HttpServer } from 'node:http';
import type { Readable, Writable } from 'node:stream';

import { WebSocketServer } from 'ws';

import { lineSplitter, parseMessage } from '@acentric/protocol';

import type { LocalRunner } from '../runner.js';
import { connect } from './connection.js';

/** Serves one connection over a pair of streams. Resolves when the input ends. */
export function serveStreams(
  runner: LocalRunner,
  input: Readable,
  output: Writable,
): Promise<void> {
  const connection = connect(runner, {
    send: (message) => {
      output.write(`${JSON.stringify(message)}\n`);
    },
  });
  input.setEncoding('utf8');
  input.on(
    'data',
    lineSplitter((line) => connection.receive(parseMessage(line))),
  );
  return new Promise((resolve) => {
    const end = (): void => {
      connection.closed();
      resolve();
    };
    input.once('end', end);
    input.once('close', end);
  });
}

export type WebSocketListener = {
  /** Where it listens, as a ws:// URL. */
  url: string;
  /** Stops listening and closes every connection. */
  close(): Promise<void>;
};

/**
 * Serves connections over WebSocket: on its own port, or on an HTTP server
 * that also serves other things, such as a page that talks to the runner.
 */
export async function serveWebSocket(
  runner: LocalRunner,
  options: { host: string; port: number } | { server: HttpServer },
): Promise<WebSocketListener> {
  const server =
    'server' in options
      ? new WebSocketServer({ server: options.server })
      : new WebSocketServer({ host: options.host, port: options.port });
  server.on('connection', (socket) => {
    const connection = connect(runner, {
      send: (message) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
      },
    });
    socket.on('message', (data) => {
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : new TextDecoder().decode(data);
      connection.receive(parseMessage(text));
    });
    socket.on('close', () => connection.closed());
    socket.on('error', () => socket.terminate());
  });
  if (!('server' in options)) {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  }
  const address = 'server' in options ? options.server.address() : server.address();
  const bound = typeof address === 'object' && address !== null ? address : null;
  const host = 'server' in options ? (bound?.address ?? '127.0.0.1') : options.host;
  return {
    url: `ws://${host}:${bound?.port ?? 0}`,
    close: () =>
      new Promise((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  };
}
