// A response that came as a stream of events, read whole and made into the one response a
// call gives, as if it had come as JSON.
//
// The last event, `response.completed` (or `incomplete`, or `failed`), carries the response
// but not always its output. Each finished item comes in its own `response.output_item.done`,
// so the output is those, in the order of their `output_index`.

import type { Json, JsonObject } from '@acentric/protocol';

import { ModelFailure } from '../failure.ts';
import { isArray, isObject } from '../json.ts';
import { events } from '../sse.ts';

/** The events that end a response, with the status each means when the response does not say. */
const LAST: { readonly [type: string]: string } = {
  'response.completed': 'completed',
  // An older name for the same, as some servers still send it.
  'response.done': 'completed',
  'response.incomplete': 'incomplete',
  'response.failed': 'failed',
};

/** The response the events of a stream make. */
export function assemble(text: string, provider: string, label: string): JsonObject {
  const items: { readonly index: number; readonly item: Json }[] = [];
  for (const event of events(text, provider, label)) {
    const type = event['type'];
    if (type === 'response.output_item.done' && event['item'] !== undefined) {
      const index = event['output_index'];
      items.push({ index: typeof index === 'number' ? index : items.length, item: event['item'] });
      continue;
    }
    if (type === 'error') {
      // An error in place of a response: what is left of the stream says nothing more.
      const { type: _type, sequence_number: _sequence, ...error } = event;
      return {
        object: 'response',
        status: 'failed',
        error: isObject(event['error']) ? event['error'] : error,
      };
    }
    const status = typeof type === 'string' ? LAST[type] : undefined;
    if (status !== undefined) {
      const response = isObject(event['response']) ? event['response'] : {};
      const given = response['output'];
      const output =
        items.length > 0 || !isArray(given)
          ? items.toSorted((a, b) => a.index - b.index).map((entry) => entry.item)
          : given;
      return {
        ...response,
        object: 'response',
        status: typeof response['status'] === 'string' ? response['status'] : status,
        output,
      };
    }
  }
  // Most likely the connection was lost on the way: the call is worth making again.
  throw new ModelFailure(`${label}'s stream ended before its response did`, 'invalid_response', {
    provider,
    retryable: true,
  });
}
