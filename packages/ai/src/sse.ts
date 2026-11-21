// A stream of server-sent events, read after it has all come: the JSON each event carries.

import type { JsonObject } from '@acentric/protocol';

import { ModelFailure } from './failure.ts';
import { isObject } from './json.ts';

/** The events of a stream, in order. One whose data is not a JSON object is left out. */
export function events(text: string, provider: string, label: string): JsonObject[] {
  const found: JsonObject[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data === '' || data === '[DONE]') continue;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      throw new ModelFailure(`${label} sent an event that is not JSON`, 'invalid_response', {
        provider,
        retryable: true,
      });
    }
    if (isObject(event)) found.push(event);
  }
  return found;
}
