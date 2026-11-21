// What a thing is called, three ways, none of which is its ID (see `ids.ts`):
//
//   name         what people call it, and type: unique among its kind, and can be changed.
//   external ID  what a caller's own system calls it: the caller's to choose, and to find it by.
//   label        a few words about it, for a person to read. Two things may have the same.
//
// The old harness had one field for all of these and the ID too, which let a name be taken for
// an ID and an ID be chosen from outside.

import { z } from 'zod';

import { parseId } from './ids.ts';

/** A name: lowercase letters, digits, `-` and `_`, starting with a letter or digit, 63 at most. */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/**
 * A name. It is never one that reads as an ID, so that a command given either can tell which
 * it was given.
 */
export const nameSchema = z
  .string()
  .regex(
    NAME_PATTERN,
    'A name is lowercase letters, digits, - and _, starting with a letter or digit, 63 at most',
  )
  .refine((value) => parseId(value) === undefined, 'A name cannot have the form of an ID')
  .meta({
    description: 'What people call it. Unique among its kind, and can be changed.',
    examples: ['support'],
  });

export type Name = z.infer<typeof nameSchema>;

/**
 * An external ID: what the caller's own system calls the thing, such as a chat's ID for the
 * actor that answers in it. Creating with one that is taken gives back what has it.
 */
export const externalIdSchema = z
  .string()
  .min(1)
  .max(256)
  // No control characters: it is shown, logged and compared as it is.
  .regex(/^\P{Cc}+$/u, 'An external ID has no control characters')
  .meta({
    description:
      "The caller's own ID for it. Creating with one that is taken gives back what has it.",
    examples: ['telegram:4411'],
  });

export type ExternalId = z.infer<typeof externalIdSchema>;

/** A label: a line of text for a person. */
export const labelSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .meta({ description: 'A few words for a person to read. Not unique.' });

export type Label = z.infer<typeof labelSchema>;
