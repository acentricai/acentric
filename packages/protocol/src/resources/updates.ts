// The server's version, and the versions after it: what GitHub's releases of the engine say, as
// the server last asked them, with each one's notes. Which to take next follows VERSIONS.md: a
// patch, or the next minor, never past it.

import { z } from 'zod';

import { timestampSchema } from '../primitives.ts';

export const releaseSchema = z
  .object({
    /** Such as 0.16.1. */
    version: z.string(),
    publishedAt: timestampSchema,
    /** Its page on GitHub. */
    url: z.string(),
    /** What changed, as its release notes say: Markdown. */
    notes: z.string(),
  })
  .meta({ id: 'Release' });
export type Release = z.infer<typeof releaseSchema>;

export const updatesSchema = z
  .object({
    /** The version this server is. */
    current: z.string(),
    /**
     * Whether the server asks: `off` for a server started with ACENTRIC_UPDATE_CHECK=off, and
     * `failed` when it could not, `error` saying why.
     */
    check: z.enum(['ok', 'failed', 'off']),
    /** When it last asked. Null before it has. */
    checkedAt: timestampSchema.nullable(),
    error: z.string().nullable(),
    /** The newest version there is. Null when there is none newer, or the server did not ask. */
    latest: z.string().nullable(),
    /** The version to take next: a patch of this one, or the next minor. Null for none. */
    next: z.string().nullable(),
    /** The versions after this one, newest first. */
    releases: z.array(releaseSchema),
  })
  .meta({ id: 'Updates' });
export type Updates = z.infer<typeof updatesSchema>;

export const updatesQuerySchema = z.object({
  /** Asks again now, rather than reading what was asked a while ago. */
  refresh: z.stringbool().optional(),
});
