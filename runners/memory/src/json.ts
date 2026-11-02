// Checks on values crossing between the runner and an agent.

import type { Json, JsonObject } from '@acentric/types';

/** Whether a value is plain Json: no undefined, NaN, Infinity, functions or class instances. */
export function isJson(value: unknown): value is Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  if (typeof value !== 'object') return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.values(value).every((item) => item !== undefined && isJson(item))
  );
}

/** Throws if `value` is not plain Json, saying what it is. */
export function requireJson(value: unknown, what: string): Json {
  if (!isJson(value)) throw new TypeError(`${what} is not plain Json`);
  return value;
}

/** Freezes `value` and everything inside it. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

/** A frozen deep copy of a Json value. */
export function frozenCopy<T extends Json>(value: T): T {
  return deepFreeze(structuredClone(value));
}

/**
 * What a thrown value says, as Json: what its `toJSON()` returns when that is
 * Json, as docs/reference/runner-spec.md §8 requires, and otherwise its name and message.
 */
export function thrownToJson(error: unknown): Json {
  const own = ownJson(error);
  if (own !== undefined) return own;
  if (error instanceof Error) return { name: error.name, message: error.message };
  return isJson(error) ? error : `a thrown ${typeof error} that is not Json`;
}

/** What a value's `toJSON()` returns, if it has one that returns Json. */
function ownJson(value: unknown): Json | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const toJSON: unknown = Reflect.get(value, 'toJSON');
  if (typeof toJSON !== 'function') return undefined;
  try {
    const json: unknown = Reflect.apply(toJSON, value, []);
    return isJson(json) ? json : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a Json value is an object. `Array.isArray` cannot say so: it does
 * not narrow a readonly JsonArray out of Json.
 */
export function isJsonObject(value: Json): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
