// One call of a provider over HTTP: the request is sent, and the answer is read whole, as text
// and as JSON when it is JSON. A provider that answers as a stream of events is read to the
// end of the stream: nothing is given of it meanwhile.

import type { Json, JsonObject } from '@acentric/protocol';

import { ModelFailure } from './failure.ts';

/** The longest a call may take, in milliseconds: one read whole, and one that comes as a stream. */
export const MAX_CALL_MS = 15 * 60 * 1000;
export const MAX_STREAM_MS = 60 * 60 * 1000;
/** The longest a stream may send nothing. A long answer is long; a quiet one is lost. */
export const STREAM_IDLE_MS = 5 * 60 * 1000;

export type HttpRequest = {
  /** Names the provider in a failure, such as "OpenAI". */
  readonly label: string;
  readonly provider: string;
  readonly url: string;
  readonly headers: { readonly [name: string]: string };
  readonly body: JsonObject;
  readonly signal: AbortSignal;
  readonly fetch?: typeof fetch;
  /** Whether the answer comes as a stream of events. */
  readonly streamed: boolean;
};

export type HttpAnswer = {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  /** The answer as JSON, when it is JSON. */
  readonly body: Json | undefined;
};

/** How long a provider said to wait, in milliseconds, when it said. */
export function retryAfter(headers: Headers): number | undefined {
  const ms = Number(headers.get('retry-after-ms'));
  if (headers.has('retry-after-ms') && Number.isFinite(ms) && ms >= 0) return Math.round(ms);
  const after = headers.get('retry-after');
  if (after === null) return undefined;
  const seconds = Number(after);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(after);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

export async function post(request: HttpRequest): Promise<HttpAnswer> {
  const { label, provider, signal, streamed } = request;
  const send = request.fetch ?? fetch;
  // What stops the call: whoever asked for it, the longest it may take, or a stream gone quiet.
  const stop = new AbortController();
  let why: 'asked' | 'long' | 'quiet' | undefined;
  const asked = () => {
    why ??= 'asked';
    stop.abort();
  };
  if (signal.aborted) asked();
  else signal.addEventListener('abort', asked, { once: true });
  const longest = setTimeout(
    () => {
      why ??= 'long';
      stop.abort();
    },
    streamed ? MAX_STREAM_MS : MAX_CALL_MS,
  );

  try {
    const response = await send(request.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...request.headers },
      body: JSON.stringify(request.body),
      signal: stop.signal,
    });
    const text = await read(response, streamed && response.ok, stop, () => {
      why ??= 'quiet';
    });
    let body: Json | undefined;
    try {
      body = text === '' ? undefined : (JSON.parse(text) as Json);
    } catch {
      body = undefined;
    }
    return { status: response.status, headers: response.headers, text, body };
  } catch (error) {
    // Whoever asked for the call stopped it: that is theirs to say, not a failure of the call.
    if (why === 'asked') throw signal.reason ?? error;
    if (why === 'long') {
      throw new ModelFailure(`the ${label} call took too long`, 'timeout', { provider });
    }
    if (why === 'quiet') {
      const seconds = String(STREAM_IDLE_MS / 1000);
      throw new ModelFailure(`the ${label} call sent nothing for ${seconds} seconds`, 'timeout', {
        provider,
      });
    }
    if (error instanceof ModelFailure) throw error;
    const said = error instanceof Error ? error.message : String(error);
    throw new ModelFailure(`the ${label} call did not get through: ${said}`, 'network', {
      provider,
    });
  } finally {
    clearTimeout(longest);
    signal.removeEventListener('abort', asked);
  }
}

/** The whole of an answer. A stream is given up when it sends nothing for too long. */
async function read(
  response: Response,
  watched: boolean,
  stop: AbortController,
  quiet: () => void,
): Promise<string> {
  if (!watched || response.body === null) return response.text();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const idle = setTimeout(() => {
      quiet();
      stop.abort();
    }, STREAM_IDLE_MS);
    try {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      text += decoder.decode(value, { stream: true });
    } finally {
      clearTimeout(idle);
    }
  }
}
