// Gates for runners that run handlers in other processes. The adapter
// serves gates over a local TCP socket, and each handler process loads
// `@acentric/conformance/remote-hook`, which installs a
// `globalThis.conformance` that talks to it. One JSON message per line:
//
//   hook -> server   { op: 'gate', id, key }      a gate waits under key
//   hook -> server   { op: 'signal', id }         its signal fired
//   server -> hook   { op: 'release', id, outcome }
//
// A gate whose process goes away stops waiting, so a scenario's release
// reaches the gate of the effect's next attempt rather than a dead one.

import { createServer } from 'node:net';
import type { Socket } from 'node:net';

import type { GateControl, GateOutcome } from './hook.js';

/** The environment variable that tells the remote hook where the server is. */
export const GATE_SERVER_ENV = 'ACENTRIC_CONFORMANCE_GATES';

export type GateServer = GateControl & {
  /** Environment variables to give handler processes. */
  env: Record<string, string>;
  close(): Promise<void>;
};

type Waiting = { socket: Socket; id: number };

function reply(socket: Socket, id: number, outcome: GateOutcome): void {
  socket.write(`${JSON.stringify({ op: 'release', id, outcome })}\n`);
}

export async function serveGates(): Promise<GateServer> {
  const waiting = new Map<string, Waiting>();
  const early = new Map<string, GateOutcome>();
  const signalled: string[] = [];
  const sockets = new Set<Socket>();

  const server = createServer((socket) => {
    sockets.add(socket);
    const gates = new Map<number, string>();
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const message: unknown = JSON.parse(line);
        if (typeof message !== 'object' || message === null) continue;
        const op: unknown = Reflect.get(message, 'op');
        const id: unknown = Reflect.get(message, 'id');
        if (typeof id !== 'number') continue;
        if (op === 'gate') {
          const key = String(Reflect.get(message, 'key'));
          const outcome = early.get(key);
          if (outcome !== undefined) {
            early.delete(key);
            reply(socket, id, outcome);
          } else {
            gates.set(id, key);
            waiting.set(key, { socket, id });
          }
        } else if (op === 'signal') {
          const key = gates.get(id);
          if (key !== undefined && !signalled.includes(key)) signalled.push(key);
        }
      }
    });
    socket.on('close', () => {
      sockets.delete(socket);
      for (const [key, gate] of waiting) if (gate.socket === socket) waiting.delete(key);
    });
    socket.on('error', () => socket.destroy());
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('the gate server has no port');

  return {
    hook: {
      gate: () => Promise.reject(new Error('gates of a gate server run in handler processes')),
    },
    release(key, outcome) {
      const gate = waiting.get(key);
      if (gate === undefined) {
        early.set(key, outcome);
        return;
      }
      waiting.delete(key);
      reply(gate.socket, gate.id, outcome);
    },
    signalled: () => [...signalled],
    waiting: () => [...waiting.keys()],
    env: { [GATE_SERVER_ENV]: `127.0.0.1:${address.port}` },
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
