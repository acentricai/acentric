// Reading Json whose shape is not known in advance, such as a provider's items.

import type { Json, JsonObject } from '@acentric/types';

/** Whether a value is a Json object. `Array.isArray` alone does not narrow a readonly array out. */
export function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a value is a Json array. */
export function isArray(value: Json | undefined): value is readonly Json[] {
  return Array.isArray(value);
}
