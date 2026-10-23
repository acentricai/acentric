// A reference adapter: the simulator from @acentric/testing, with the
// probe's handlers run in this process. It is a small runner that keeps
// nothing past the process and cannot upgrade, enough to check that the
// scenarios themselves say what RUNNERS.md says before a real runner exists.

import { handlerContext, simulate } from '@acentric/testing';
import type { Simulation } from '@acentric/testing';
import type { Delivery } from '@acentric/testing';
import type { EffectRequest, HandlerDef, Json, JsonObject, Kinds, Outcome } from '@acentric/types';

import { createGateHook, isJson } from '../src/index.js';
import type { Adapter, Answer } from '../src/index.js';
import probe from '../src/probe/agent.js';
import type { ProbeSnapshot } from '../src/probe/core.js';
import badHandlers from '../src/probe/handlers-bad-name.js';
import probeHandlers from '../src/probe/handlers.js';

type Flight = {
  controller: AbortController;
  emitted: Json[];
  done: boolean;
  aborted: boolean;
};

export function referenceAdapter(): Adapter {
  const control = createGateHook();
  Reflect.set(globalThis, 'conformance', control.hook);
  let sim: Simulation<ProbeSnapshot, JsonObject, Kinds> | null = null;
  const handlers: Record<string, HandlerDef> = probeHandlers;
  const flights = new Map<string, Flight>();

  const current = (): Simulation<ProbeSnapshot, JsonObject, Kinds> => {
    if (sim === null) throw new Error('no instance has been created');
    return sim;
  };

  function handle(delivery: Delivery<Kinds>): void {
    for (const key of delivery.cancelled) flights.get(key)?.controller.abort();
    for (const key of delivery.aborted) {
      const flight = flights.get(key);
      if (flight !== undefined) {
        flight.aborted = true;
        flight.controller.abort();
      }
    }
    for (const request of delivery.started) start(request);
  }

  function start(request: EffectRequest): void {
    const handler = handlers[request.kind];
    if (handler === undefined) {
      handle(
        current().report(request.key, { failed: { code: 'unknown_kind', error: request.kind } }),
      );
      return;
    }
    const { ctx, controller, emitted } = handlerContext({
      args: request.args,
      key: request.key,
      kind: request.kind,
      log: current().log,
    });
    const flight: Flight = { controller, emitted, done: false, aborted: false };
    flights.set(request.key, flight);
    if (handler.timeoutMs !== undefined) {
      setTimeout(() => {
        controller.abort();
        finish(request.key, { failed: { code: 'timeout', error: null } });
      }, handler.timeoutMs);
    }
    handler.run(ctx).then(
      (value: unknown) =>
        finish(
          request.key,
          isJson(value) ? { ok: value } : { failed: { code: 'invalid_result', error: null } },
        ),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        finish(request.key, {
          failed: { code: flight.aborted ? 'aborted' : 'threw', error: message },
        });
      },
    );
  }

  function finish(key: string, outcome: Outcome): void {
    const flight = flights.get(key);
    if (flight === undefined || flight.done) return;
    flight.done = true;
    // A cancelled effect's result is discarded.
    if (!current().running.some((request) => request.key === key)) return;
    handle(current().report(key, outcome));
  }

  /** Whether a handler is still running, other than a gate waiting to be released. */
  function busy(): boolean {
    return [...flights.entries()].some(
      ([key, flight]) => !flight.done && !control.waiting().includes(key),
    );
  }

  function answer(send: () => Delivery<Kinds>): Answer {
    try {
      const delivery = send();
      if (delivery.rejected !== null) return { rejected: delivery.rejected };
      handle(delivery);
      return { accepted: true };
    } catch (error) {
      return { failed: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    supports: [],
    create: (bundle, config) => {
      if (bundle === 'probe-bad-handler-name') {
        const names = Object.keys(badHandlers).filter((name) => name.startsWith('@'));
        if (names.length > 0)
          return Promise.resolve({
            rejected: `handler names reserved for runners: ${names.join(', ')}`,
          });
      }
      const created = probe.init(config, Date.now());
      if ('error' in created) return Promise.resolve({ rejected: created.error });
      sim = simulate(probe, config, { now: Date.now() });
      for (const request of sim.running) start(request);
      return Promise.resolve({ accepted: true });
    },
    input: (kind, payload) => Promise.resolve(answer(() => current().input(kind, payload))),
    configure: (config) => Promise.resolve(answer(() => current().configure(config))),
    release: (key, outcome) => {
      control.release(key, outcome);
      return Promise.resolve();
    },
    settle: async () => {
      const deadline = Date.now() + 5_000;
      while (busy()) {
        if (Date.now() > deadline) throw new Error('the runner did not settle within 5 seconds');
        // Settling waits on handlers this process runs, one tick at a time.
        // oxlint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    },
    running: () =>
      Promise.resolve(
        (sim?.running ?? []).map((request) => ({
          key: request.key,
          kind: request.kind,
          args: request.args,
          attempt: 1,
          abort: request.abort === true,
        })),
      ),
    signalled: () => Promise.resolve(control.signalled()),
    // With no instance, as after a rejected create, there is nothing to show.
    log: () => Promise.resolve([...(sim?.log ?? [])]),
    snapshot: () => Promise.resolve(sim?.snapshot ?? {}),
    emitted: (key) => Promise.resolve(flights.get(key)?.emitted ?? []),
    close: () => {
      for (const flight of flights.values()) flight.controller.abort();
      Reflect.deleteProperty(globalThis, 'conformance');
      return Promise.resolve();
    },
  };
}
