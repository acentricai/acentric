// The memory runner's conformance adapter. A crash closes the runner and
// starts a new one over the same store, which is all a memory runner keeps.

import { createGateHook } from '@acentric/conformance';
import type { Adapter, Answer } from '@acentric/conformance';
import probe from '@acentric/conformance/probe/agent';
import probeV2 from '@acentric/conformance/probe/agent-v2';
import probeHandlers from '@acentric/conformance/probe/handlers';
import badHandlers from '@acentric/conformance/probe/handlers-bad-name';
import type { Json } from '@acentric/types';

import { createMemoryRunner, createMemoryStore } from '../src/index.js';
import type { MemoryRunner } from '../src/index.js';

export function memoryAdapter(): Adapter {
  const control = createGateHook();
  Reflect.set(globalThis, 'conformance', control.hook);
  const store = createMemoryStore();
  const emitted = new Map<string, Json[]>();
  let runner = open();
  let id: string | null = null;

  function open(): MemoryRunner {
    const next = createMemoryRunner({ store });
    next.load(probe, probeHandlers);
    next.load(probeV2, probeHandlers);
    return next;
  }

  function listen(): void {
    if (id === null) return;
    runner.onEmit(id, (key, delta) => {
      emitted.set(key, [...(emitted.get(key) ?? []), delta]);
    });
  }

  function instance(): string {
    if (id === null) throw new Error('no instance has been created');
    return id;
  }

  /** Whether a handler is running, other than a gate waiting to be released. */
  function busy(): boolean {
    const waiting = control.waiting();
    return (
      id !== null &&
      runner.running(id).some((effect) => effect.active && !waiting.includes(effect.key))
    );
  }

  return {
    supports: ['durable', 'upgrade'],
    create: (bundle, config) => {
      if (bundle === 'probe-bad-handler-name') {
        try {
          createMemoryRunner().load({ ...probe, name: 'probe-bad' }, badHandlers);
        } catch (error) {
          return Promise.resolve({ rejected: error instanceof Error ? error.message : 'refused' });
        }
      }
      const { id: created, ...answer } = runner.create(probe, config);
      if (created !== undefined) {
        id = created;
        listen();
      }
      return Promise.resolve(answer);
    },
    input: (kind, payload) => runner.input(instance(), kind, payload),
    configure: (config) => runner.configure(instance(), config),
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
        id === null
          ? []
          : runner.running(id).map(({ key, kind, args, attempt, abort }) => ({
              key,
              kind,
              args,
              attempt,
              abort,
            })),
      ),
    signalled: () => Promise.resolve(control.signalled()),
    // With no instance, as after a rejected create, there is nothing to show.
    log: () => Promise.resolve(id === null ? [] : [...runner.log(id)]),
    snapshot: () => Promise.resolve(id === null ? {} : runner.snapshot(id)),
    emitted: (key) => Promise.resolve(emitted.get(key) ?? []),
    crash: () => {
      runner.close();
      runner = open();
      listen();
      runner.start();
      return Promise.resolve();
    },
    upgrade: (): Promise<Answer> => runner.upgrade(instance(), probeV2),
    close: () => {
      runner.close();
      Reflect.deleteProperty(globalThis, 'conformance');
      return Promise.resolve();
    },
  };
}
