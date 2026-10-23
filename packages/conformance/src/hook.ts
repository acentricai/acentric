// The gate hook: how a scenario holds a `gate` effect running and decides
// when and how it finishes.
//
// A runner's adapter installs a hook as `globalThis.conformance` wherever
// the probe's handlers run. The probe's `gate` handler calls
// `conformance.gate(key, signal)` and finishes with what the scenario
// releases. Runners written in TypeScript can use `createGateHook`; others
// implement the same small interface in the JavaScript they host.

import type { Json } from '@acentric/types';

/** How a gate finishes: returning a value, or throwing an error with a message. */
export type GateOutcome = { return: Json } | { throw: string };

/** What a gate handler finds on `globalThis.conformance`. */
export type ConformanceHook = {
  /** Waits until the scenario releases `key`. */
  gate(key: string, signal: AbortSignal): Promise<GateOutcome>;
};

export type GateControl = {
  /** The hook to install as `globalThis.conformance`. */
  hook: ConformanceHook;
  /** Finishes the gate waiting under `key`, or the next one to wait under it. */
  release(key: string, outcome: GateOutcome): void;
  /** Keys of gates whose signal fired, in the order it fired. */
  signalled(): string[];
  /** Keys of gates waiting to be released. */
  waiting(): string[];
};

export function createGateHook(): GateControl {
  const waiting = new Map<string, (outcome: GateOutcome) => void>();
  const early = new Map<string, GateOutcome>();
  const signalled: string[] = [];

  const hook: ConformanceHook = {
    gate(key, signal) {
      const markSignalled = (): void => {
        if (!signalled.includes(key)) signalled.push(key);
      };
      if (signal.aborted) markSignalled();
      else signal.addEventListener('abort', markSignalled, { once: true });
      const outcome = early.get(key);
      if (outcome !== undefined) {
        early.delete(key);
        return Promise.resolve(outcome);
      }
      return new Promise((resolve) => waiting.set(key, resolve));
    },
  };

  return {
    hook,
    release(key, outcome) {
      const resolve = waiting.get(key);
      if (resolve === undefined) {
        early.set(key, outcome);
        return;
      }
      waiting.delete(key);
      resolve(outcome);
    },
    signalled: () => [...signalled],
    waiting: () => [...waiting.keys()],
  };
}

/** The hook installed on `globalThis.conformance`, if there is one. */
export function installedHook(): ConformanceHook | null {
  const hook: unknown = Reflect.get(globalThis, 'conformance');
  if (typeof hook !== 'object' || hook === null) return null;
  const gate: unknown = Reflect.get(hook, 'gate');
  if (typeof gate !== 'function') return null;
  return {
    gate: async (key, signal) => {
      const outcome: unknown = await Reflect.apply(gate, hook, [key, signal]);
      if (isGateOutcome(outcome)) return outcome;
      throw new Error('the conformance hook released a gate with something that is not an outcome');
    },
  };
}

function isGateOutcome(value: unknown): value is GateOutcome {
  if (typeof value !== 'object' || value === null) return false;
  if (typeof Reflect.get(value, 'throw') === 'string') return true;
  return Reflect.has(value, 'return') && isJson(Reflect.get(value, 'return'));
}

/** Whether a value is plain Json. */
export function isJson(value: unknown): value is Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  if (typeof value !== 'object') return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) && Object.values(value).every(isJson)
  );
}
