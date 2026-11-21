// What following an actor is sent: the events of `GET /v1/actors/{actor}/events`, a stream of
// server-sent events.
//
//   message  one more message of the conversation, whole. It is what `messages` lists.
//   status   where the actor stands, sent when that changes, and after the messages it follows
//            from: a client told the actor is idle has every message of the turn that ended.
//
// A model's answer is sent once, when it is whole and stored. Nothing is sent of an answer
// while the model writes it: that is data nobody keeps, and nothing here is built on it.
//
// Coming back after a break, a client says the last place in the conversation it saw, in the
// `Last-Event-ID` header or as `after`. It is sent every message after that, and where the
// actor stands.

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

export const actorEventSchema = z
  .discriminatedUnion('type', [messageEventSchema, statusEventSchema])
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
