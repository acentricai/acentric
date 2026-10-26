// The digest a journal entry holds: what a change left, as a short string
// any runner, in any language, computes the same way.

import { createHash } from 'node:crypto';

import type { Json, JsonArray, JsonObject } from '@acentric/types';

/**
 * SHA-256, as lowercase hex, of the RFC 8785 canonical JSON of
 * `[snapshot, config, appended]`, `appended` being the log entries the
 * change added as `{ kind, body }`.
 */
export function journalDigest(
  snapshot: JsonObject,
  config: JsonObject,
  appended: readonly { kind: string; body: Json }[],
): string {
  const value = [snapshot, config, appended.map(({ kind, body }) => ({ kind, body }))];
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/**
 * RFC 8785: no whitespace, object keys sorted by their UTF-16 code units,
 * and strings and numbers written as JSON.stringify writes them.
 */
export function canonicalJson(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (isJsonArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).toSorted();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`).join(',')}}`;
}

/** `Array.isArray` as a guard that narrows a readonly JsonArray out of Json. */
function isJsonArray(value: Json): value is JsonArray {
  return Array.isArray(value);
}
