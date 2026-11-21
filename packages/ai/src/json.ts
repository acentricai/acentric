// Reading JSON whose shape is another's to decide.

import type { Json, JsonObject } from '@acentric/protocol';

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isArray(value: unknown): value is Json[] {
  return Array.isArray(value);
}

/** A count of tokens, when it is one. */
export function tokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** `object` without the fields named. */
export function omit(object: JsonObject, fields: readonly string[]): JsonObject {
  return Object.fromEntries(Object.entries(object).filter(([key]) => !fields.includes(key)));
}
