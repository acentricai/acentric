// Compactions: what an actor's model is sent in place of the older part of its conversation,
// once the conversation has grown long. Nothing is taken out of the conversation: a
// compaction says what stands for its start, and from where it is sent as it is.

import { z } from 'zod';

import { timestampSchema } from '../primitives.ts';
import { actorSchema } from './actors.ts';

/**
 * How a conversation was compacted. `older`: its provider summarized the older part, and the
 * recent turns follow as they were. `all`: its provider compacted all of it into one item.
 * `summary`: its own model wrote a summary of the older part.
 */
export const compactionKindSchema = z.enum(['older', 'all', 'summary']);
export type CompactionKind = z.infer<typeof compactionKindSchema>;

/**
 * Why it was compacted: it had grown past its size, its provider refused a call as too large,
 * or someone asked.
 */
export const compactionReasonSchema = z.enum(['threshold', 'overflow', 'asked']);
export type CompactionReason = z.infer<typeof compactionReasonSchema>;

export const compactionSchema = z
  .object({
    kind: compactionKindSchema,
    /** The place in the conversation it was made at. */
    atSeq: z.number().int(),
    /** From this place on the conversation is sent as it is. */
    keepFromSeq: z.number().int(),
    /** How large the conversation was, in tokens, as its provider last counted it. */
    tokensBefore: z.number().int(),
    reason: compactionReasonSchema,
    createdAt: timestampSchema,
  })
  .meta({ id: 'Compaction' });
export type Compaction = z.infer<typeof compactionSchema>;

/** An actor, and what compacting its conversation came to: null when there was nothing to compact. */
export const compactResponseSchema = z
  .object({ actor: actorSchema, compacted: compactionSchema.nullable() })
  .meta({ id: 'CompactResponse' });
export type CompactResponse = z.infer<typeof compactResponseSchema>;

/** An agent's own numbers for a model: how large a conversation may grow, and how much of its end is kept, in tokens. */
export const compactionSettingsSchema = z.record(
  z.string().min(1),
  z.strictObject({
    threshold: z.number().int().nonnegative().optional(),
    reserve: z.number().int().nonnegative().optional(),
  }),
);
export type CompactionSettings = z.infer<typeof compactionSettingsSchema>;
