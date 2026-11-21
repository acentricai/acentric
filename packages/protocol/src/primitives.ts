// The small shapes every part of the API shares: a time, a page of a list.

import { z } from 'zod';

/** A time: milliseconds since the Unix epoch, as `Date.now()` gives. */
export const timestampSchema = z
  .number()
  .int()
  .nonnegative()
  .meta({ description: 'Milliseconds since the Unix epoch.', examples: [1795305600000] });

export type Timestamp = z.infer<typeof timestampSchema>;

/** The most a list gives at once, and what it gives when a request does not say. */
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

/**
 * What a request for a list says of the page it wants, in its query. A cursor is the
 * `nextCursor` of the page before: it means nothing to a client, and is not kept for long.
 */
export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().min(1).optional(),
});

export type PageQuery = z.infer<typeof pageQuerySchema>;

/** A page of a list: its items, and the cursor of the next page, or null on the last. */
export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}

export type Page<T> = { items: T[]; nextCursor: string | null };
