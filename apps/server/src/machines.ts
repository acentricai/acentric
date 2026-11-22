// Where the machines' daemons connect: `GET /v1/machines/{machine}/connect`, upgraded to a
// WebSocket. It is no route of the API's table: a daemon is let in by proving it holds its
// machine's key, on the connection itself (see `machines.ts` in the engine).

import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import type { MachineSocket, Machines } from '@acentric/core';
import { machineIdSchema, machineOfConnectPath } from '@acentric/protocol';
import type { WebSocket, WebSocketServer } from 'ws';

/** How long a connection that was closed with a reason has to go before it is ended. */
const CLOSE_MS = 2000;

/** A daemon's WebSocket, as the engine takes a connection. */
function socketOf(socket: WebSocket): MachineSocket {
  return {
    send: (text) => {
      socket.send(text);
    },
    close: (code, reason) => {
      if (code === undefined) {
        socket.terminate();
        return;
      }
      socket.close(code, reason);
      // A daemon that does not close its side is not waited for.
      setTimeout(() => {
        socket.terminate();
      }, CLOSE_MS).unref();
    },
    onMessage: (listener) => {
      socket.on('message', (data, isBinary) => {
        // A daemon sends text, and nothing else.
        if (!isBinary) listener(String(data as Buffer));
      });
    },
    onClose: (listener) => {
      socket.on('close', listener);
      // A failed connection closes too, and says so then.
      socket.on('error', () => {});
    },
  };
}

/** Takes the daemons' connections on an HTTP server, for the engine's machines. */
export function takeDaemons(server: Server, sockets: WebSocketServer, machines: Machines): void {
  const refuse = (socket: Duplex): void => {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  };
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const named = machineOfConnectPath(request.url ?? '');
    const id = named === undefined ? undefined : machineIdSchema.safeParse(named);
    if (id?.success !== true) {
      refuse(socket);
      return;
    }
    socket.on('error', () => {});
    machines
      .accepts(id.data)
      .then((accepted) => {
        // No machine of that ID, or one whose daemon has not enrolled: nothing is said of which.
        if (!accepted) {
          refuse(socket);
          return;
        }
        sockets.handleUpgrade(request, socket, head, (webSocket) => {
          machines.connect(id.data, socketOf(webSocket));
        });
      })
      .catch(() => {
        refuse(socket);
      });
  });
}
