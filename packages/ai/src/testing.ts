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

/**
 * The provider of the models of tests, `fake`. Its model `fake-1` does not tie its reasoning
 * to what came before it, and `fake-bound` does.
 */
export function fakeProvider(
  runner: ModelRunner,
  options: {
    /** Whether its reasoning level can be changed from a place in a conversation on. */
    readonly changesReasoningInPlace?: boolean;
    /** The keys it takes when a key is checked. Every key, without it. */
    readonly keys?: readonly string[];
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
    id: 'fake',
    label: 'Fake',
    credentials: ['api_key'],
    models: [
      { id: 'fake-1', name: 'Fake 1', bindsReasoning: false },
      { id: 'fake-bound', name: 'Fake Bound', bindsReasoning: true },
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
