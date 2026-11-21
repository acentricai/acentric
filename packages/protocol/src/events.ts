// What following an actor is sent: the events of `GET /v1/actors/{actor}/events`, a stream of
// server-sent events.
//
//   message  one more message of the conversation. It is kept: it is what `messages` lists.
//   status   where the actor stands, sent when that changes, and after the messages it follows
//            from: a client told the actor is idle has every message of the turn that ended.
//   delta    a piece of the answer the model is writing now. It is not kept.
//
// Coming back after a break, a client says the last place in the conversation it saw, in the
// `Last-Event-ID` header or as `after`. It is sent every message after that, and where the
// actor stands. Deltas are not sent again as they were: for an answer still being written, the
// first delta of each part is a snapshot, with all of that part so far.

import { z } from 'zod';

import { actorStatusSchema, conversationEntrySchema, turnEndSchema } from './resources/actors.ts';

export const messageEventSchema = z.object({
  type: z.literal('message'),
  entry: conversationEntrySchema,
});

export const statusEventSchema = z.object({
  type: z.literal('status'),
  status: actorStatusSchema,
  lastTurn: turnEndSchema.nullable(),
  pendingInputs: z.number().int().nonnegative(),
});

export const deltaEventSchema = z.object({
  type: z.literal('delta'),
  /** Which answer this is a piece of. The answer's deltas end when its message comes. */
  answer: z.string().min(1),
  /** Which part of the answer: its text, its reasoning and each tool call are parts, from 0. */
  part: z.number().int().nonnegative(),
  kind: z.enum(['text', 'reasoning', 'tool_input']),
  /** What to add to the part, or all of it so far for a snapshot. */
  text: z.string(),
  /** This is all of the part so far, in place of what the client has of it. */
  snapshot: z.literal(true).optional(),
});

export const actorEventSchema = z
  .discriminatedUnion('type', [messageEventSchema, statusEventSchema, deltaEventSchema])
  .meta({ id: 'ActorEvent' });
export type ActorEvent = z.infer<typeof actorEventSchema>;

/** One server-sent event: its name, its data, and its ID when a client can come back to it. */
export type SseFrame = {
  readonly event: string;
  readonly data: string;
  readonly id?: string;
};

/**
 * An event as it is sent. Only a message has an ID, its place in the conversation: that is
 * what a client coming back says it saw last.
 */
export function toSse(event: ActorEvent): SseFrame {
  const frame = { event: event.type, data: JSON.stringify(event) };
  return event.type === 'message' ? { ...frame, id: String(event.entry.seq) } : frame;
}

/** The event a frame carries. Throws when its data is not an event. */
export function fromSse(frame: Pick<SseFrame, 'data'>): ActorEvent {
  return actorEventSchema.parse(JSON.parse(frame.data));
}
