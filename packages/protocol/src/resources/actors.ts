// Actors: an agent running for someone. An actor has a conversation and a mailbox. It is sent
// inputs, which wait in its mailbox until a turn takes them into the conversation, and it is
// never done: it works, or it is idle.

import { z } from 'zod';

import { actorIdSchema, agentIdSchema, inputIdSchema } from '../ids.ts';
import { jsonSchema } from '../json.ts';
import { inputTypeSchema } from '../manifest.ts';
import {
  messageSchema,
  modelIdSchema,
  reasoningSchema,
  stopReasonSchema,
  usageSchema,
} from '../messages.ts';
import { externalIdSchema, nameSchema } from '../names.ts';
import { pageQuerySchema, timestampSchema } from '../primitives.ts';
import { deploymentRefSchema } from './agents.ts';

/**
 * What an actor is doing: `working` in a turn, `idle` between turns, and `archived` when it
 * was put away, and takes no input.
 */
export const actorStatusSchema = z.enum(['idle', 'working', 'archived']);
export type ActorStatus = z.infer<typeof actorStatusSchema>;

/** How an actor's last turn ended. A failure is told here, not in the conversation. */
export const turnEndSchema = z.object({
  /** `refused`: the model declined, and what it was sent is left out of the conversation from then on. */
  end: z.enum(['ok', 'failed', 'interrupted', 'refused']),
  /** Why it failed or was refused, or what interrupted it. */
  reason: z.string().optional(),
  at: timestampSchema,
});
export type TurnEnd = z.infer<typeof turnEndSchema>;

export const actorSchema = z
  .object({
    id: actorIdSchema,
    /** Null for one that was given none: an actor needs no name. */
    name: nameSchema.nullable(),
    /** The caller's own ID for it, unique among its agent's actors. Null for one with none. */
    externalId: externalIdSchema.nullable(),
    agent: agentIdSchema,
    /** The deployment of its agent whose code it runs. */
    deployment: deploymentRefSchema,
    modelId: modelIdSchema,
    reasoning: reasoningSchema,
    /** Its configuration, as its agent's schema returned it. Null for an agent that takes none. */
    configuration: jsonSchema.nullable(),
    status: actorStatusSchema,
    /** Null until it has had a turn. */
    lastTurn: turnEndSchema.nullable(),
    /** How many inputs wait in its mailbox for a turn. */
    pendingInputs: z.number().int().nonnegative(),
    createdAt: timestampSchema,
    /** Null for one that is not archived. */
    archivedAt: timestampSchema.nullable(),
  })
  .meta({ id: 'Actor' });
export type Actor = z.infer<typeof actorSchema>;

/**
 * What an actor is created with. None of it is needed. With an external ID that an actor of
 * the agent has already, that actor is given back and nothing is made.
 */
export const createActorRequestSchema = z
  .strictObject({
    name: nameSchema.optional(),
    externalId: externalIdSchema.optional(),
    /** Without it, the default model of the agent's provider. */
    modelId: modelIdSchema.optional(),
    reasoning: reasoningSchema.optional(),
    /** What the agent's configuration schema takes. */
    configuration: jsonSchema.optional(),
  })
  .meta({ id: 'CreateActorRequest' });
export type CreateActorRequest = z.infer<typeof createActorRequestSchema>;

export const createActorResponseSchema = z
  .object({
    actor: actorSchema,
    /** False when the external ID was an actor's already: that actor is the one given. */
    created: z.boolean(),
  })
  .meta({ id: 'CreateActorResponse' });
export type CreateActorResponse = z.infer<typeof createActorResponseSchema>;

/** What of an actor can be changed, between its turns. A name of null takes its name away. */
export const updateActorRequestSchema = z
  .strictObject({
    name: nameSchema.nullable().optional(),
    modelId: modelIdSchema.optional(),
    reasoning: reasoningSchema.optional(),
    /** In place of the one it has, whole. */
    configuration: jsonSchema.optional(),
  })
  .meta({ id: 'UpdateActorRequest' });
export type UpdateActorRequest = z.infer<typeof updateActorRequestSchema>;

/** Which actors a list gives. Each filter narrows it. */
export const listActorsQuerySchema = pageQuerySchema.extend({
  agent: agentIdSchema.optional(),
  status: actorStatusSchema.optional(),
  name: nameSchema.optional(),
  externalId: externalIdSchema.optional(),
});
export type ListActorsQuery = z.infer<typeof listActorsQuerySchema>;

// Inputs

/**
 * Something sent to an actor. Its payload is checked by the agent's schema for its type. With
 * an external ID the actor was sent before, nothing is stored again: sending is safe to repeat.
 */
export const sendInputRequestSchema = z
  .strictObject({
    type: inputTypeSchema,
    payload: jsonSchema.default(null),
    externalId: externalIdSchema.optional(),
  })
  .meta({ id: 'SendInputRequest' });
export type SendInputRequest = z.infer<typeof sendInputRequestSchema>;

export const sendInputResponseSchema = z
  .object({
    input: inputIdSchema,
    /** `duplicate` when the actor was sent this external ID before. */
    status: z.enum(['accepted', 'duplicate']),
  })
  .meta({ id: 'SendInputResponse' });
export type SendInputResponse = z.infer<typeof sendInputResponseSchema>;

/** An input in an actor's mailbox. */
export const inputSchema = z
  .object({
    id: inputIdSchema,
    actor: actorIdSchema,
    type: inputTypeSchema,
    externalId: externalIdSchema.nullable(),
    /** The message it is in the conversation, or will be. */
    message: messageSchema,
    receivedAt: timestampSchema,
    /** When a turn took it into the conversation. Null while it waits. */
    deliveredAt: timestampSchema.nullable(),
  })
  .meta({ id: 'Input' });
export type Input = z.infer<typeof inputSchema>;

export const listInputsQuerySchema = pageQuerySchema.extend({
  /** Only those that wait, or only those a turn has taken. Both without it. */
  pending: z.stringbool().optional(),
});
export type ListInputsQuery = z.infer<typeof listInputsQuerySchema>;

// The conversation

/** One message of an actor's conversation, with its place in it. */
export const conversationEntrySchema = z
  .object({
    /** Its place in the conversation, from 1. */
    seq: z.number().int().positive(),
    message: messageSchema,
    createdAt: timestampSchema,
    /** For a message an input became: the input. */
    input: z.object({ id: inputIdSchema, type: inputTypeSchema }).optional(),
    /** For a model's answer: why it stopped, and what it used. */
    completion: z
      .object({ stopReason: stopReasonSchema, usage: usageSchema.optional() })
      .optional(),
    /** Of a turn the model refused: kept here, and not sent to the model again. */
    leftOut: z.literal(true).optional(),
  })
  .meta({ id: 'ConversationEntry' });
export type ConversationEntry = z.infer<typeof conversationEntrySchema>;

/**
 * Which part of a conversation is asked for. It is read forwards from after `after`, or
 * backwards from before `before`: the newest messages first is `order=desc` with neither.
 */
export const listMessagesQuerySchema = pageQuerySchema.extend({
  after: z.coerce.number().int().nonnegative().optional(),
  before: z.coerce.number().int().positive().optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
});
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;
