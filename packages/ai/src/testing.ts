// A model for tests: it says what a test told it to. No provider is called.

import { ModelFailure } from './failure.ts';
import { withoutTypes } from './provider.ts';
import type { Provider } from './provider.ts';
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

/** An answer with reasoning before whatever else it has. */
export function reasoned(reasoning: string, answer: ModelAnswer): ModelAnswer {
  const content = [{ type: 'reasoning', text: reasoning }, ...answer.message.content];
  return { ...answer, message: { ...answer.message, content } };
}

/** An answer to a step that asked for a compaction: what stands for the conversation, and nothing else. */
export function compacted(summary: string): ModelAnswer {
  return {
    message: { ...FAKE, content: [{ type: 'compaction', content: summary }] },
    stopReason: 'pause_turn',
    toolCalls: [],
  };
}

/** An answer with what its call took in and gave out, in tokens. */
export function used(answer: ModelAnswer, totalInput: number, output = 0): ModelAnswer {
  return { ...answer, usage: { totalInput, input: totalInput, output } };
}

/**
 * The provider of the models of tests, `fake`. Its model `fake-1` does not tie its reasoning
 * to what came before it, and `fake-bound` does. `fake-eyes` is one that reads images.
 */
export function fakeProvider(
  runner: ModelRunner,
  options: {
    /** Whether its reasoning level can be changed from a place in a conversation on. */
    readonly changesReasoningInPlace?: boolean;
    /** The keys it takes when a key is checked. Every key, without it. */
    readonly keys?: readonly string[];
    /** How it compacts a conversation itself. It has no compaction of its own, without it. */
    readonly compacts?: 'older' | 'all';
  } = {},
): Provider {
  return {
    ...(options.changesReasoningInPlace === true
      ? {
          reasoningChange: (_model, reasoning) => ({
            role: 'native',
            provider: 'fake',
            api: 'fake',
            content: [{ type: 'reasoning_level', level: reasoning }],
          }),
        }
      : {}),
    ...(options.compacts === undefined
      ? {}
      : {
          compacts: options.compacts,
          compacted(message) {
            const left = message.content.filter((item) => item['type'] === 'compaction');
            return left.length === 1 ? { ...message, content: left } : undefined;
          },
        }),
    id: 'fake',
    label: 'Fake',
    credentials: ['api_key'],
    models: [
      { id: 'fake-1', name: 'Fake 1', bindsReasoning: false },
      { id: 'fake-bound', name: 'Fake Bound', bindsReasoning: true },
      { id: 'fake-eyes', name: 'Fake Eyes', bindsReasoning: false, input: ['text', 'image'] },
    ],
    defaultModel: 'fake-1',
    bindsReasoning: true,
    async check({ credential }) {
      const key = credential.type === 'api_key' ? credential.apiKey : credential.accessToken;
      if (key === 'unreachable') {
        throw new ModelFailure('Fake could not be reached to check the key', 'network');
      }
      if (options.keys !== undefined && !options.keys.includes(key)) {
        throw new ModelFailure('Fake refused the key: it is not one it takes', 'auth');
      }
    },
    parseOptions: (given) => (given ?? {}) as ReturnType<Provider['parseOptions']>,
    runner: () => runner,
    read: (message) => ({
      text: message.content
        .map((item) => (item['type'] === 'text' ? String(item['text']) : ''))
        .join(''),
      reasoning: message.content
        .filter((item) => item['type'] === 'reasoning')
        .map((item) => String(item['text'])),
      toolCalls: [],
    }),
    withoutReasoning: (message) => withoutTypes(message, ['reasoning']),
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
