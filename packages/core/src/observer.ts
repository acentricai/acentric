// What an engine tells of what its actors do, as they do it: for its logs and its metrics.
// Nothing here changes what happens, and an observer that throws is not heard from again on
// that call: the engine goes on.

import type { TurnEnd } from '@acentric/protocol';

import type { UsageRecord } from './usage.ts';

/** A tool call that was answered: of the agent's code, the engine's own tool, or a task. */
export type ToolKind = 'agent' | 'engine' | 'task';

export type EngineObserver = {
  /** An actor went from idle to working. */
  readonly turnStarted?: (turn: { readonly actor: string; readonly agent: string }) => void;
  /** An actor's turn ended. `durationMs` is undefined for one this process did not start. */
  readonly turnEnded?: (turn: {
    readonly actor: string;
    readonly agent: string;
    readonly end: TurnEnd['end'];
    readonly reason?: string;
    readonly durationMs: number | undefined;
  }) => void;
  /** A model was called, for a turn or a compaction: what it used, or how it failed. */
  readonly modelCalled?: (call: UsageRecord) => void;
  /** A tool call was answered. */
  readonly toolFinished?: (tool: {
    readonly actor: string;
    readonly agent: string;
    readonly name: string;
    readonly kind: ToolKind;
    readonly isError: boolean;
    readonly durationMs: number;
  }) => void;
};

/** Tells `observer` of `what`, and keeps what it throws from the engine. */
export function tell<K extends keyof EngineObserver>(
  observer: EngineObserver | undefined,
  what: K,
  ...args: Parameters<NonNullable<EngineObserver[K]>>
): void {
  const told = observer?.[what] as ((...given: typeof args) => void) | undefined;
  if (told === undefined) return;
  try {
    told(...args);
  } catch {
    // An observer's own failure is its own.
  }
}
