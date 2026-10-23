// Checks that values crossing the framework's boundaries are plain Json, and
// freezes what a step is given, so a test fails where a runner would.

import type { Json } from '@acentric/types';

/** Throws if `value` is not plain Json, naming where the problem is. */
export function assertJson(value: unknown, where: string): asserts value is Json {
  check(value, where);
}

function check(value: unknown, path: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} is ${value}, which is not Json`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => check(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} is a ${value.constructor.name}, which is not Json`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) throw new TypeError(`${path}.${key} is undefined, which is not Json`);
      check(item, `${path}.${key}`);
    }
    return;
  }
  throw new TypeError(`${path} is a ${typeof value}, which is not Json`);
}

/** Freezes `value` and everything inside it, so mutating it throws. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
