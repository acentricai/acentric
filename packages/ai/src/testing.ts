// A model for tests: it says what a test told it to. No provider is called.

import type { ModelAnswer, ModelRunner, ModelStep, ToolCall } from './runner.ts';

const FAKE = { role: 'assistant', provider: 'fake', api: 'fake', model: 'fake-1' } as const;

/** An answer that is text and nothing else. */
export function says(text: string): ModelAnswer {
  return {
    message: { ...FAKE, content: [{ type: 'text', text }] },
    stopReason: 'stop',
    toolCalls: [],
  };
}

/** An answer that calls tools. */
export function calls(...toolCalls: ToolCall[]): ModelAnswer {
  return {
    message: { ...FAKE, content: toolCalls.map((call) => ({ type: 'tool_call', ...call })) },
    stopReason: 'tool_use',
    toolCalls,
  };
}

/** What a scripted model does at one call: an answer, or what works one out, or throws. */
export type Scripted =
  ModelAnswer | ((step: ModelStep, signal: AbortSignal) => ModelAnswer | Promise<ModelAnswer>);

/** Gives the answers a test wrote, one at each call, and keeps what it was called with. */
export class ScriptedRunner implements ModelRunner {
  readonly #script: Scripted[];
  readonly steps: ModelStep[] = [];

  constructor(script: readonly Scripted[]) {
    this.#script = [...script];
  }

  async run(step: ModelStep, signal: AbortSignal): Promise<ModelAnswer> {
    this.steps.push(structuredClone(step));
    const next = this.#script.shift();
    if (next === undefined) throw new Error('The script has no more answers');
    return typeof next === 'function' ? next(step, signal) : next;
  }
}

/**
 * A model with no script, which answers by what it is shown: it calls `tool` once for each
 * message of a user's, and says the tool's result back. It gives the same answer to the same
 * conversation, whichever process asks, so it can be asked again after a restart.
 */
export function echoRunner(tool: string): ModelRunner {
  return {
    async run(step) {
      const last = step.messages.at(-1);
      if (last?.role === 'tool_result') {
        const said = last.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
        return says(said);
      }
      const asked = step.messages.filter((message) => message.role === 'user').length;
      return calls({ id: `call-${String(asked)}`, name: tool, arguments: { asked } });
    },
  };
}
