// Builders for scripted model replies and tool results, and a simulation of
// the pi agent with a small config.

import { simulate } from '@acentric/testing';
import type { Simulation } from '@acentric/testing';
import type { Json, LogEntry } from '@acentric/types';

import { piAgent } from '../src/index.js';
import type {
  AssistantMessage,
  PiConfig,
  PiKinds,
  PiSnapshot,
  StopReason,
  ToolCallBlock,
  Usage,
} from '../src/index.js';

export type PiSimulation = Simulation<PiSnapshot, PiConfig, PiKinds>;

export const CWD = '/repo';

export function config(overrides: Partial<PiConfig> = {}): PiConfig {
  return { cwd: CWD, model: { provider: 'anthropic', id: 'claude-sonnet-5-5' }, ...overrides };
}

export function start(overrides: Partial<PiConfig> = {}): PiSimulation {
  return simulate(piAgent, config(overrides), { now: 1_000 });
}

export function usage(totalTokens: number, output = 10): Usage {
  return { input: totalTokens - output, output, cacheRead: 0, cacheWrite: 0, totalTokens, cost: 0 };
}

export function reply(
  content: AssistantMessage['content'],
  stopReason: StopReason = content.some((block) => block.type === 'toolCall') ? 'toolUse' : 'stop',
  extra: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    content,
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    usage: usage(100),
    stopReason,
    ...extra,
  };
}

export function text(value: string): { type: 'text'; text: string } {
  return { type: 'text', text: value };
}

export function call(id: string, name: string, args: Record<string, Json>): ToolCallBlock {
  return { type: 'toolCall', id, name, arguments: args };
}

export function failure(errorMessage: string): AssistantMessage {
  return reply([], 'error', { errorMessage, usage: usage(0, 0) });
}

export function toolOk(output: string): Json {
  return { content: [text(output)], isError: false };
}

/** The key of the one running effect of `kind`. */
export function keyOf(sim: PiSimulation, kind: keyof PiKinds): string {
  const running = sim.effectsOf(kind);
  if (running.length !== 1 || running[0] === undefined) {
    throw new Error(`expected one ${kind} effect, found ${running.length}`);
  }
  return running[0].key;
}

/** The log entries of one kind. */
export function entries(sim: PiSimulation, kind: string): LogEntry[] {
  return sim.log.filter((entry) => entry.kind === kind);
}

/** Sends a prompt and answers its model call with `content`. */
export function prompt(
  sim: PiSimulation,
  message: string,
  content: AssistantMessage['content'],
): void {
  sim.input('prompt', { text: message });
  sim.ok(keyOf(sim, 'llm'), reply(content));
}
