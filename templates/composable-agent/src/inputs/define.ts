// How an input is defined. Each one names its kind and its payload schema,
// so step can check what a caller sends before acting on it. There are two
// kinds of input:
//   - a message input becomes a user message the model sees. It starts a
//     turn, or waits for one by its delivery.
//   - a control input is acted on by step itself, such as an interrupt.
//     The model never sees it.

import type { UserMessage } from '@acentric/llm';
import { Type } from 'typebox';
import type { Static, TProperties, TSchema } from 'typebox';
import { Value } from 'typebox/value';

import { Delivery } from './config.js';

/** A message input, `S` its payload schema with the `delivery` field added. */
export type MessageInputDef<S extends TSchema = TSchema> = {
  readonly role: 'message';
  readonly kind: string;
  readonly payload: S;
  /** The user message the model sees, and when it reaches it. */
  read(payload: Static<S>): { message: UserMessage; delivery: Delivery | undefined };
};

/** A control input, `S` its payload schema. */
export type ControlInputDef<S extends TSchema = TSchema> = {
  readonly role: 'control';
  readonly kind: string;
  readonly payload: S;
};

export type InputDef = MessageInputDef | ControlInputDef;

/**
 * Defines a message input from its payload's fields, and how a payload
 * becomes the user message the model sees. Its payload gets an optional
 * `delivery` field, so every message input can say when it reaches the model.
 */
export function messageInput<P extends TProperties>(def: {
  kind: string;
  payload: P;
  toUserMessage: (payload: Static<ReturnType<typeof withDelivery<P>>>) => UserMessage;
}) {
  const payload = withDelivery(def.payload);
  return {
    role: 'message',
    kind: def.kind,
    payload,
    read: (body) => ({ message: def.toUserMessage(body), delivery: deliveryOf(body) }),
  } satisfies MessageInputDef<typeof payload>;
}

/** A message input's payload schema: its own fields, and `delivery`. */
function withDelivery<P extends TProperties>(fields: P) {
  return Type.Object(
    { ...fields, delivery: Type.Optional(Delivery) },
    { additionalProperties: false },
  );
}

/** The delivery a checked message payload names, if any. */
function deliveryOf(payload: unknown): Delivery | undefined {
  return typeof payload === 'object' &&
    payload !== null &&
    'delivery' in payload &&
    Value.Check(Delivery, payload.delivery)
    ? payload.delivery
    : undefined;
}

/** Defines a control input from its payload's fields. */
export function controlInput<P extends TProperties>(def: { kind: string; payload: P }) {
  const payload = Type.Object(def.payload, { additionalProperties: false });
  return { role: 'control', kind: def.kind, payload } satisfies ControlInputDef<typeof payload>;
}
