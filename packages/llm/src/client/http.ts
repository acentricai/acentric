// One HTTP exchange with a provider or the gateway: a JSON body out, a JSON
// body back, stopped by the handler's signal or a time limit. Never retried:
// whether to try again is the agent's decision.

import type { Json } from '@acentric/types';

import { LlmError } from '../failure.js';
import { cut } from './util.js';

/** The longest one call may take, and the default, in milliseconds. */
export const MAX_TIMEOUT_MS = 15 * 60 * 1000;

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export type Post = {
  readonly provider: string;
  /** Names the other end in messages, such as "Anthropic". */
  readonly label: string;
  readonly url: string;
  readonly headers: { readonly [name: string]: string };
  readonly body: Json;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  /** Turns an answer that is not 2xx into an error. */
  readonly failed: (answer: HttpAnswer) => LlmError;
  /** Whether the answer's request ID is the provider's, for its failures to name. Defaults to true. */
  readonly providerAnswers?: boolean;
};

/** An answer that is not 2xx. */
export type HttpAnswer = {
  readonly status: number;
  readonly headers: Headers;
  /** The JSON body, or the text body cut short. */
  readonly body: Json;
};

export type JsonAnswer = {
  readonly body: Json;
  readonly durationMs: number;
  /** When the answer arrived, in milliseconds since the Unix epoch. */
  readonly timestamp: number;
  readonly requestId?: string;
};

export async function postJson(post: Post): Promise<JsonAnswer> {
  const { provider, label } = post;
  const timeoutMs = Math.min(post.timeoutMs ?? MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);
  if (!(Number.isSafeInteger(timeoutMs) && timeoutMs > 0)) {
    throw new LlmError('timeoutMs must be a positive whole number', {
      kind: 'invalid_request',
      provider,
    });
  }
  const controller = new AbortController();
  const onAbort = () =>
    controller.abort(
      new LlmError(`the ${label} call was cancelled`, { kind: 'cancelled', provider }),
    );
  post.signal?.addEventListener('abort', onAbort, { once: true });
  if (post.signal?.aborted === true) onAbort();
  const timer = setTimeout(
    () =>
      controller.abort(
        new LlmError(`the ${label} call took longer than ${timeoutMs} ms`, {
          kind: 'timeout',
          provider,
        }),
      ),
    timeoutMs,
  );
  const started = performance.now();
  let requestId: string | undefined;
  try {
    controller.signal.throwIfAborted();
    const send = post.fetch ?? globalThis.fetch;
    // Raced against the signal, so a fetch that does not watch it cannot outlast a timeout.
    const response = await untilAborted(
      send(post.url, {
        method: 'POST',
        headers: requestHeaders(provider, post.headers),
        body: JSON.stringify(post.body),
        signal: controller.signal,
        redirect: 'manual',
      }),
      controller.signal,
    );
    if (post.providerAnswers !== false) requestId = readRequestId(response.headers);
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => undefined);
      throw new LlmError(`${label} answered with a redirect, which is not followed`, {
        kind: 'network_error',
        provider,
      });
    }
    const text = await readText(response, provider, label);
    controller.signal.throwIfAborted();
    if (!response.ok) {
      throw post.failed({
        status: response.status,
        headers: response.headers,
        body: parseLoosely(text),
      });
    }
    let body: Json;
    try {
      body = JSON.parse(text);
    } catch {
      throw new LlmError(`${label} answered with something that is not JSON`, {
        kind: 'invalid_response',
        provider,
        httpStatus: response.status,
        providerError: cut(text),
      });
    }
    return {
      body,
      durationMs: Math.round(performance.now() - started),
      timestamp: Date.now(),
      ...(requestId === undefined ? {} : { requestId }),
    };
  } catch (error) {
    const reason: unknown = controller.signal.aborted ? controller.signal.reason : error;
    if (reason instanceof LlmError) throw withRequestId(reason, requestId);
    throw new LlmError(`${label} could not be reached`, {
      kind: 'network_error',
      provider,
      ...(requestId === undefined ? {} : { requestId }),
    });
  } finally {
    clearTimeout(timer);
    post.signal?.removeEventListener('abort', onAbort);
  }
}

/** `Retry-After` in milliseconds, given in seconds or as an HTTP date. */
export function retryAfter(headers: Headers): number | undefined {
  const value = headers.get('retry-after')?.trim();
  if (value === undefined || value === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.round(seconds * 1000) : undefined;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** A failure from after the provider answered names its request ID, for its support. */
export function withRequestId(error: LlmError, requestId: string | undefined): LlmError {
  if (requestId === undefined || error.failure.requestId !== undefined) return error;
  return LlmError.fromJSON({ ...error.failure, requestId });
}

/** The promise's value, or the signal's reason as soon as it fires. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function requestHeaders(provider: string, entries: { readonly [name: string]: string }): Headers {
  try {
    return new Headers({
      accept: 'application/json',
      'content-type': 'application/json',
      ...entries,
    });
  } catch {
    throw new LlmError('the credentials hold characters a header cannot', {
      kind: 'invalid_request',
      provider,
    });
  }
}

function readRequestId(answer: Headers): string | undefined {
  const id =
    answer.get('x-request-id') ?? answer.get('request-id') ?? answer.get('x-oai-request-id');
  return id?.trim() || undefined;
}

function parseLoosely(text: string): Json {
  try {
    return JSON.parse(text);
  } catch {
    return cut(text);
  }
}

async function readText(response: Response, provider: string, label: string): Promise<string> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const decode = (value?: Uint8Array): string => {
    try {
      return decoder.decode(value, { stream: value !== undefined });
    } catch {
      throw new LlmError(`${label} answered with text that is not UTF-8`, {
        kind: 'invalid_response',
        provider,
        httpStatus: response.status,
      });
    }
  };
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      // Reading a stream is one chunk at a time.
      // oxlint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        throw new LlmError(`${label} answered with more than ${MAX_RESPONSE_BYTES} bytes`, {
          kind: 'invalid_response',
          provider,
          httpStatus: response.status,
        });
      }
      text += decode(value);
    }
    return text + decode();
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
