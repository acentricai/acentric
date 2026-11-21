// A message of Anthropic's that came as a stream of events, read whole and made into the one
// message a call gives, as if it had come as JSON.
//
// `message_start` carries the message with nothing in it. Each block then has a
// `content_block_start`, its deltas, and a `content_block_stop`; some blocks come whole.
// `message_delta` carries why it stopped and the usage, counted so far, and `message_stop`
// ends it. An `error` event is the failure the call would have had over HTTP.

import type { JsonObject } from '@acentric/protocol';

import { ModelFailure } from '../failure.ts';
import { isArray, isObject } from '../json.ts';
import { events } from '../sse.ts';
import { httpFailure } from './errors.ts';
import { LABEL, PROVIDER } from './request.ts';

/** The message the events of a stream make. */
export function assemble(text: string): JsonObject {
  let message: JsonObject | undefined;
  let ended = false;
  const blocks: JsonObject[] = [];
  // What a tool is called with, as it came, put together when its block stops.
  const inputs = new Map<number, string>();
  for (const event of events(text, PROVIDER, LABEL)) {
    const index = typeof event['index'] === 'number' ? event['index'] : undefined;
    switch (event['type']) {
      case 'message_start':
        if (isObject(event['message'])) message = { ...event['message'], content: [] };
        break;
      case 'content_block_start':
        if (index !== undefined && isObject(event['content_block']))
          blocks[index] = { ...event['content_block'] };
        break;
      case 'content_block_delta': {
        const block = index === undefined ? undefined : blocks[index];
        if (block === undefined || index === undefined || !isObject(event['delta'])) break;
        const { type, ...delta } = event['delta'];
        if (type === 'input_json_delta') {
          const piece = typeof delta['partial_json'] === 'string' ? delta['partial_json'] : '';
          inputs.set(index, (inputs.get(index) ?? '') + piece);
        } else if (type === 'citations_delta') {
          const citations = isArray(block['citations']) ? block['citations'] : [];
          block['citations'] =
            delta['citation'] === undefined ? citations : [...citations, delta['citation']];
        } else {
          // Text, thinking, a signature, and kinds not known yet: text adds to the field of
          // its name, and anything else takes its place.
          for (const [field, value] of Object.entries(delta)) {
            const before = block[field];
            block[field] =
              typeof value === 'string' && typeof before === 'string' ? before + value : value;
          }
        }
        break;
      }
      case 'content_block_stop': {
        const block = index === undefined ? undefined : blocks[index];
        const input = index === undefined ? undefined : inputs.get(index);
        if (block !== undefined && input !== undefined && input !== '') {
          try {
            block['input'] = JSON.parse(input);
          } catch {
            // Cut off before it was whole, by the limit on an answer or by a refusal: why it
            // stopped says so, and no call of it is made.
          }
        }
        break;
      }
      case 'message_delta': {
        if (message === undefined) break;
        const { type: _type, delta, usage, ...rest } = event;
        const before = isObject(message['usage']) ? message['usage'] : {};
        message = {
          ...message,
          ...(isObject(delta) ? delta : {}),
          ...rest,
          ...(isObject(usage) ? { usage: { ...before, ...usage } } : {}),
        };
        break;
      }
      case 'message_stop':
        ended = true;
        break;
      case 'error':
        // In place of the rest of the message: the failure the call would have had.
        throw httpFailure({ status: 200, headers: new Headers(), body: event, text: '' });
      default:
        // A ping, and kinds of event added since.
        break;
    }
  }
  if (message === undefined || !ended) {
    // Most likely the connection was lost on the way: the call is worth making again.
    throw new ModelFailure(`the ${LABEL} stream ended before its message did`, 'invalid_response', {
      provider: PROVIDER,
      retryable: true,
    });
  }
  return { ...message, content: blocks.filter((block) => block !== undefined) };
}
