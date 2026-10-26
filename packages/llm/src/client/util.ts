// Small helpers the adapters share.

import type { Json, JsonObject } from '@acentric/types';

import { LlmError } from '../failure.js';
import { isArray, isObject } from '../json.js';

export function invalidRequest(provider: string | undefined, message: string): LlmError {
  return new LlmError(message, {
    kind: 'invalid_request',
    ...(provider === undefined ? {} : { provider }),
  });
}

export function invalidResponse(provider: string, message: string, body?: Json): LlmError {
  return new LlmError(message, {
    kind: 'invalid_response',
    provider,
    ...(body === undefined ? {} : { providerError: cut(body) }),
  });
}

/**
 * A part's `providerOptions`, or the request's `options`, refused when it sets
 * a field the client sets itself on the same object: that is never
 * overwritten silently.
 */
export function ownFields(
  provider: string,
  fields: Json | undefined,
  owned: readonly string[],
  where: string,
  field = 'providerOptions',
): JsonObject {
  if (fields === undefined) return {};
  if (!isObject(fields)) throw invalidRequest(provider, `${where}.${field} must be an object`);
  for (const key of owned) {
    if (key in fields) {
      throw invalidRequest(
        provider,
        `${where}.${field}.${key} is set by the request: set it there`,
      );
    }
  }
  return fields;
}

/** A count of tokens: a whole number, zero or more. */
export function tokens(value: Json | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** `record` without `keys`, and without fields that are null, which say nothing. */
export function omit(record: JsonObject, keys: readonly string[]): JsonObject {
  const skip = new Set(keys);
  return Object.fromEntries(
    Object.entries(record).filter(([key, value]) => !skip.has(key) && value !== null),
  );
}

/** Error bodies are cut short, so a proxy's HTML page does not fill a failure. */
export function cut(body: Json): Json {
  return typeof body === 'string' && body.length > 4096 ? body.slice(0, 4096) : body;
}

/** The text of content that is one text part with no options: sent as a plain string. */
export function plainText(content: Json | undefined): string | undefined {
  if (!isArray(content) || content.length !== 1) return undefined;
  const [only] = content;
  return isObject(only) &&
    only['type'] === 'text' &&
    typeof only['text'] === 'string' &&
    only['providerOptions'] === undefined
    ? only['text']
    : undefined;
}

/** A value as a message shows it. */
export function show(value: Json | undefined): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? 'nothing');
}
