// The server's own backups: where they go, how often, what became of the last, and those there
// are, on the server and in the bucket they are copied to. A backup is not read through the
// API: it has every conversation and every sealed secret in it, and is had by whoever runs the
// server, from its folder or its bucket.

import { z } from 'zod';

import { timestampSchema } from '../primitives.ts';

export const backupKindSchema = z.enum(['scheduled', 'before-upgrade', 'manual']);
export type BackupKind = z.infer<typeof backupKindSchema>;

export const backupSchema = z
  .object({
    /** Its file's name, in the backups' folder. */
    name: z.string(),
    /** Taken every so often, before a new version changed the database, or when asked for. */
    kind: backupKindSchema,
    /** The version that took it: for one before an upgrade, the version it was upgraded to. */
    version: z.string(),
    createdAt: timestampSchema,
    bytes: z.number().int().nonnegative(),
    /** Whether it is in the folder on the server. */
    onServer: z.boolean(),
    /** Whether it is in the bucket backups are copied to. */
    inBucket: z.boolean(),
  })
  .meta({ id: 'Backup' });
export type Backup = z.infer<typeof backupSchema>;

export const backupsSchema = z
  .object({
    /** The folder they go in, on the server. */
    dir: z.string(),
    /** Whether that is the disk of what they back up: they are lost with it. */
    sameDisk: z.boolean(),
    /** The bucket each is copied to as well, and what went wrong listing it, when something did. */
    bucket: z.object({ url: z.string(), error: z.string().nullable() }).nullable(),
    /** How often one is taken. */
    everyMs: z.number().int().positive(),
    /** How many of each kind are kept. */
    keep: z.number().int().positive(),
    /** When the next is taken. */
    next: timestampSchema.nullable(),
    /** What became of the last one taken since the server started. */
    last: z
      .discriminatedUnion('ok', [
        z.object({ ok: z.literal(true), at: timestampSchema, name: z.string() }),
        z.object({ ok: z.literal(false), at: timestampSchema, error: z.string() }),
      ])
      .nullable(),
    /** Those there are, newest first. */
    items: z.array(backupSchema),
  })
  .meta({ id: 'Backups' });
export type Backups = z.infer<typeof backupsSchema>;
