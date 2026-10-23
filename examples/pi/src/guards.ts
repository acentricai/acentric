// Checks for values that arrive from outside the agent, such as config and
// input payloads. The framework only promises they are Json.

import type { Json, JsonObject } from '@acentric/types';

import type { ImageBlock, ModelRef, ThinkingLevel } from './content.js';

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a value of unknown origin, such as parsed text, is plain Json. */
export function isJson(value: unknown): value is Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  if (typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return (
    (prototype === Object.prototype || prototype === null) && Object.values(value).every(isJson)
  );
}

/** Parses Json text, or returns undefined if it is not Json. */
export function parseJson(text: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isJson(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** A deep copy of a Json value. */
export function copyJson(value: Json): Json {
  if (Array.isArray(value)) return value.map(copyJson);
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyJson(item)]));
  }
  return value;
}

export function isThinkingLevel(value: Json | undefined): value is ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value);
}

export function isModelRef(value: Json | undefined): value is ModelRef {
  return (
    isObject(value) && typeof value['provider'] === 'string' && typeof value['id'] === 'string'
  );
}

export function isImageBlock(value: Json): value is ImageBlock {
  return (
    isObject(value) &&
    value['type'] === 'image' &&
    typeof value['data'] === 'string' &&
    typeof value['mimeType'] === 'string'
  );
}

/** A finite number that is at least `min`. */
export function isNumberFrom(value: Json | undefined, min: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min;
}
