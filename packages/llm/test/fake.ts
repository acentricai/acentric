// A fetch that records each request and answers it from a handler, and
// secrets backed by a plain object, for testing the client without a network.

import type { Json, JsonObject, Secrets } from '@acentric/types';

export type Sent = {
  readonly url: string;
  readonly headers: Headers;
  readonly body: JsonObject;
};

export type Answer = {
  readonly status?: number;
  readonly body: Json | string;
  readonly headers?: { readonly [name: string]: string };
};

export function fakeFetch(answer: (sent: Sent) => Answer | Promise<Answer>): {
  fetch: typeof fetch;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const send = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    init?.signal?.throwIfAborted();
    const request: Sent = {
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      headers: new Headers(init?.headers),
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}'),
    };
    sent.push(request);
    const { status = 200, body, headers = {} } = await answer(request);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'x-request-id': 'req_1', ...headers },
    });
  };
  return { fetch: send, sent };
}

/** Secrets as a runner gives them: a missing one rejects with SecretNotSet. */
export function secrets(values: { readonly [name: string]: string }): Secrets {
  return {
    get: (name) => {
      const value = values[name];
      if (value !== undefined) return Promise.resolve(value);
      const error = new Error(`secret ${name} is not set`);
      error.name = 'SecretNotSet';
      return Promise.reject(error);
    },
  };
}

/** A finished Responses answer around `output`. */
export function responsesBody(output: Json[], extra: JsonObject = {}): JsonObject {
  return {
    id: 'resp_1',
    object: 'response',
    status: 'completed',
    model: 'gpt-6.1-sol',
    output,
    error: null,
    incomplete_details: null,
    instructions: 'echoed',
    temperature: 1,
    usage: {
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 600 },
      output_tokens: 200,
      output_tokens_details: { reasoning_tokens: 150 },
      total_tokens: 1200,
    },
    ...extra,
  };
}

/** A finished Anthropic answer around `content`. */
export function anthropicBody(content: Json[], extra: JsonObject = {}): JsonObject {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5-5',
    content,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 0,
    },
    ...extra,
  };
}
