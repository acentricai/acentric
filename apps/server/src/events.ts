// Following an actor: the stream of server-sent events `GET /v1/actors/{actor}/events` answers
// with. A message of the conversation is sent whole, once it is stored. Nothing is sent of an
// answer while its model writes it.
//
// One who says where they left off is sent every message after that place, then where the
// actor stands, then what happens from there. One who does not is sent where the actor
// stands, and what happens from there.

import type { Engine } from '@acentric/core';
import { toSse } from '@acentric/protocol';
import type { Actor, ActorEvent } from '@acentric/protocol';

/** How often a line that says nothing is sent, so that what is in between keeps the stream open. */
const BEAT_MS = 25_000;
/** The messages read at once when one who comes back is caught up. */
const CATCH_UP = 500;

/** The streams that are open, so that a server that stops can end them. */
export class Streams {
  readonly #open = new Set<() => void>();

  /** Ends every stream. */
  close(): void {
    for (const end of this.#open) end();
  }

  get size(): number {
    return this.#open.size;
  }

  /**
   * The stream of one who follows an actor. It ends when the request is given up, which the
   * request's signal says. The request itself is held for as long as the stream is: what
   * aborts its signal is the request's own, and goes when the request does.
   */
  follow(engine: Engine, actor: Actor, after: number | undefined, request: Request): Response {
    const { signal } = request;
    const encoder = new TextEncoder();
    let end: () => void = () => {};
    // What waits for the one who reads to take what was sent, while the past is read.
    let room: (() => void) | null = null;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let closed = false;
        // What happens while the past is read waits here, and is sent after it, in order.
        let waiting: ActorEvent[] | null = [];
        let sentTo = after ?? 0;
        const write = (text: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            // The stream is gone before its request said so: it ends here, and nothing it
            // listens to is the worse for it.
            end();
          }
        };
        const send = (event: ActorEvent) => {
          // A message that was read from the store as well is sent once.
          if (event.type === 'message') {
            if (event.entry.seq <= sentTo) return;
            sentTo = event.entry.seq;
          }
          const frame = toSse(event);
          const id = frame.id === undefined ? '' : `id: ${frame.id}\n`;
          write(`event: ${frame.event}\n${id}data: ${frame.data}\n\n`);
        };
        const unsubscribe = engine.bus.subscribe(actor.id, (event) => {
          if (waiting === null) send(event);
          else waiting.push(event);
        });
        const beat = setInterval(() => {
          write(': alive\n\n');
        }, BEAT_MS);
        end = () => {
          if (closed) return;
          closed = true;
          clearInterval(beat);
          unsubscribe();
          this.#open.delete(end);
          request.signal.removeEventListener('abort', end);
          room?.();
          try {
            controller.close();
          } catch {
            // Closed by the other side already.
          }
        };
        this.#open.add(end);
        signal.addEventListener('abort', end, { once: true });

        void (async () => {
          try {
            // Where it stands is read before the messages are: a message is stored no later
            // than what it does to where the actor stands, so every message that led there is
            // among those read after, and is sent before it.
            const now = await engine.getActor(actor.id);
            if (after !== undefined) {
              for (;;) {
                const entries = await engine.conversation(actor.id, {
                  after: sentTo,
                  limit: CATCH_UP,
                });
                for (const entry of entries) send({ type: 'message', entry });
                if (entries.length < CATCH_UP) break;
                // The next page is read once this one is taken: one who reads slowly is not
                // sent the whole conversation into memory to wait for them.
                while (!closed && (controller.desiredSize ?? 0) <= 0) {
                  await new Promise<void>((resolve) => {
                    room = resolve;
                  });
                  room = null;
                }
                if (closed) return;
              }
            }
            send({
              type: 'status',
              status: now.status,
              lastTurn: now.lastTurn,
              pendingInputs: now.pendingInputs,
            });
            const held = waiting ?? [];
            waiting = null;
            for (const event of held) send(event);
          } catch {
            // The actor went while it was followed: the stream ends.
            end();
          }
        })();
      },
      pull: () => {
        room?.();
      },
      cancel: () => {
        end();
      },
    });
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // What is in between is not to hold events back to send them together.
        'x-accel-buffering': 'no',
      },
    });
  }
}
