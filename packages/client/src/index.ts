// Talk to an acentric runner from an application. `connectWebSocket` works
// wherever WebSocket does; `@acentric/client/node` starts a runner as a
// child process and talks to it over stdio.

import { parseMessage } from '@acentric/protocol';

import { RunnerClient } from './client.js';
import type { ClientOptions, Transport } from './client.js';

export { RunnerClient, RunnerRequestError } from './client.js';
export type {
  ClientOptions,
  InstanceEvent,
  ProvidedContext,
  ProvidedHandler,
  Subscription,
  Transport,
} from './client.js';
export type * from '@acentric/protocol';

/** Connects to a runner listening on WebSocket, such as `ws://127.0.0.1:7420`. */
export async function connectWebSocket(
  url: string,
  options: ClientOptions = {},
): Promise<RunnerClient> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error(`could not connect to ${url}`)), {
      once: true,
    });
  });
  const closed = new Promise<void>((resolve) =>
    socket.addEventListener('close', () => resolve(), { once: true }),
  );
  const transport: Transport = {
    send: (message) => socket.send(JSON.stringify(message)),
    receive: (handler) => {
      socket.addEventListener('message', (event: MessageEvent) => {
        if (typeof event.data === 'string') handler(parseMessage(event.data));
      });
    },
    closed,
    close: () => socket.close(),
  };
  return RunnerClient.open(transport, options);
}
