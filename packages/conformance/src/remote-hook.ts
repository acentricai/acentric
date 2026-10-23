// Installs a `globalThis.conformance` that waits on gates served by
// `serveGates` in another process. Load it before the probe's handlers, for
// example with `node --import @acentric/conformance/remote-hook`, in a
// process whose environment has ACENTRIC_CONFORMANCE_GATES.

import { connect } from 'node:net';
import type { Socket } from 'node:net';

import { GATE_SERVER_ENV } from './gate-server.js';
import type { ConformanceHook, GateOutcome } from './hook.js';

const where = process.env[GATE_SERVER_ENV];

if (where !== undefined) {
  const [host = '127.0.0.1', port = '0'] = where.split(':');
  const pending = new Map<number, (outcome: GateOutcome) => void>();
  let socket: Socket | null = null;
  let next = 1;

  const open = (): Socket => {
    if (socket !== null) return socket;
    const opened = connect(Number(port), host);
    let buffer = '';
    opened.setEncoding('utf8');
    opened.on('data', (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
        const message: unknown = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (typeof message !== 'object' || message === null) continue;
        const id: unknown = Reflect.get(message, 'id');
        const outcome: unknown = Reflect.get(message, 'outcome');
        const resolve = typeof id === 'number' ? pending.get(id) : undefined;
        if (resolve !== undefined && isOutcome(outcome)) {
          pending.delete(Number(id));
          resolve(outcome);
        }
      }
    });
    // The gate server outlives every handler process; this connection must
    // not keep one alive.
    opened.unref();
    socket = opened;
    return opened;
  };

  const hook: ConformanceHook = {
    gate(key, signal) {
      const id = next++;
      const channel = open();
      const markSignalled = (): void => {
        channel.write(`${JSON.stringify({ op: 'signal', id })}\n`);
      };
      const released = new Promise<GateOutcome>((resolve) => pending.set(id, resolve));
      channel.write(`${JSON.stringify({ op: 'gate', id, key })}\n`);
      if (signal.aborted) markSignalled();
      else signal.addEventListener('abort', markSignalled, { once: true });
      return released;
    },
  };
  Reflect.set(globalThis, 'conformance', hook);
}

function isOutcome(value: unknown): value is GateOutcome {
  if (typeof value !== 'object' || value === null) return false;
  return typeof Reflect.get(value, 'throw') === 'string' || Reflect.has(value, 'return');
}
