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

/**
 * What the updater beside the server is doing, as it says: the image of a version downloaded
 * and checked, waiting for its time, being taken, and how that went.
 */
export const updaterStateSchema = z.enum([
  'idle',
  'downloading',
  'downloaded',
  'waiting',
  'updating',
  'done',
  'failed',
  'cancelled',
]);
export type UpdaterState = z.infer<typeof updaterStateSchema>;

export const updaterSchema = z
  .object({
    state: updaterStateSchema,
    /** The version it is about. Null when it is idle. */
    version: z.string().nullable(),
    /** When it takes it, for an update set for later. Null for now, or none. */
    at: timestampSchema.nullable(),
    /** What went wrong, when it failed. */
    error: z.string().nullable(),
    /** When it last said what it is doing. Null before it has. */
    changedAt: timestampSchema.nullable(),
  })
  .meta({ id: 'Updater' });
export type Updater = z.infer<typeof updaterSchema>;

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
    /**
     * The updater beside the server, which takes a version when asked to: null where there is
     * none (ACENTRIC_UPDATER_DIR), and a version is taken where the server runs.
     */
    updater: updaterSchema.nullable(),
  })
  .meta({ id: 'Updates' });
export type Updates = z.infer<typeof updatesSchema>;

export const updatesQuerySchema = z.object({
  /** Asks again now, rather than reading what was asked a while ago. */
  refresh: z.stringbool().optional(),
});

export const updateRequestSchema = z
  .object({
    /** The version to take: the one `next` says. */
    version: z.string().regex(/^\d+\.\d+\.\d+$/, 'is a version such as 0.16.1'),
    /** `download` gets its image and checks it, and stops there; `install` takes it too. */
    action: z.enum(['download', 'install']),
    /** When to take it, for `install`. Absent, or null, for now. */
    at: timestampSchema.nullish(),
  })
  .meta({ id: 'UpdateRequest' });
export type UpdateRequest = z.infer<typeof updateRequestSchema>;
