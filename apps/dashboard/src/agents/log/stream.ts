// Following an actor's conversation: the server sends `message` for each message, whole, as it
// is stored, and `status` each time where the actor stands changes. Nothing is sent of an answer
// while the model writes it. The client parses the server-sent events; here they are read,
// with reconnecting from the last message seen.

import type { ActorEvent, ConversationEntry } from '@acentric/protocol';

import { isApiError } from '../api.ts';

/** Where an actor stands, as the stream says it. */
export type Standing = Omit<Extract<ActorEvent, { type: 'status' }>, 'type'>;

export type StreamState = 'live' | 'reconnecting' | 'ended';

export type FollowOptions = {
  /** Opens the stream from after `after`; rejects with an ApiError when it cannot. */
  readonly open: (after: number, signal: AbortSignal) => AsyncIterable<ActorEvent>;
  /** The last `seq` already shown. */
  readonly after: number;
  readonly onMessages: (messages: ConversationEntry[]) => void;
  readonly onStanding: (standing: Standing) => void;
  readonly onState: (state: StreamState) => void;
  readonly signal: AbortSignal;
  /** Waits between tries: 1 s, doubling, at most 30 s. */
  readonly backoff?: (attempt: number) => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

export const defaultBackoff = (attempt: number) => Math.min(30_000, 1000 * 2 ** attempt);

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Reads the conversation from `after` on, as it is written, until `signal` aborts. Reconnects
 * from the last message it gave out, with backoff, and never gives out a message twice. A 401,
 * 403 or 404 ends it.
 */
export async function followConversation(options: FollowOptions): Promise<void> {
  const backoff = options.backoff ?? defaultBackoff;
  const sleep = options.sleep ?? defaultSleep;
  let last = options.after;
  let attempt = 0;
  const { signal } = options;
  while (!signal.aborted) {
    try {
      let opened = false;
      // The server sends where the actor stands after the messages it follows from, so a
      // client told the turn ended has all of it.
      for await (const event of options.open(last, signal)) {
        if (!opened) {
          opened = true;
          options.onState('live');
          attempt = 0;
        }
        if (event.type === 'status') {
          options.onStanding({
            status: event.status,
            lastTurn: event.lastTurn,
            pendingInputs: event.pendingInputs,
          });
          continue;
        }
        if (event.entry.seq <= last) continue;
        last = event.entry.seq;
        options.onMessages([event.entry]);
      }
    } catch (error) {
      if (signal.aborted) break;
      if (isApiError(error) && [401, 403, 404].includes(error.status)) {
        options.onState('ended');
        return;
      }
    }
    if (signal.aborted) break;
    options.onState('reconnecting');
    await sleep(backoff(attempt), signal);
    attempt += 1;
  }
}
