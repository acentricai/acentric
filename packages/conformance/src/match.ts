// Partial matching: an expected object matches when each field it gives
// matches; arrays and other values must match exactly.

import type { Json } from '@acentric/types';

/** Why `actual` does not match `expected`, or null if it does. */
export function mismatch(expected: Json, actual: Json | undefined, path = '$'): string | null {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${path}: expected an array, got ${show(actual)}`;
    if (actual.length !== expected.length) {
      return `${path}: expected ${expected.length} items, got ${actual.length}: ${show(actual)}`;
    }
    for (const [index, item] of expected.entries()) {
      const problem = mismatch(item, actual[index], `${path}[${index}]`);
      if (problem !== null) return problem;
    }
    return null;
  }
  if (typeof expected === 'object' && expected !== null) {
    if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) {
      return `${path}: expected an object, got ${show(actual)}`;
    }
    for (const [key, item] of Object.entries(expected)) {
      const problem = mismatch(item, actual[key], `${path}.${key}`);
      if (problem !== null) return problem;
    }
    return null;
  }
  return expected === actual ? null : `${path}: expected ${show(expected)}, got ${show(actual)}`;
}

function show(value: Json | undefined): string {
  return value === undefined ? 'nothing' : JSON.stringify(value);
}
