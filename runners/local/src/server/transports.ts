// The protocol's transports: one JSON message per line on a pair of
// streams, such as stdin and stdout, or one per WebSocket frame.

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

/** Serves connections over WebSocket. */
export async function serveWebSocket(
  runner: LocalRunner,
  options: { host: string; port: number },
): Promise<WebSocketListener> {
  const server = new WebSocketServer({ host: options.host, port: options.port });
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
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;
  return {
    url: `ws://${options.host}:${port}`,
    close: () =>
      new Promise((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  };
}
