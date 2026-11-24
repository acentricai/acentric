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

/** How often one may be taken, at the most and the least: from ten minutes to a year. */
export const BACKUP_EVERY_MS = { least: 600_000, most: 365 * 86_400_000 } as const;
/** How many of each kind may be kept. */
export const BACKUP_KEEP = { least: 1, most: 1000 } as const;

const everyMsSchema = z.number().int().min(BACKUP_EVERY_MS.least).max(BACKUP_EVERY_MS.most);
const keepSchema = z.number().int().min(BACKUP_KEEP.least).max(BACKUP_KEEP.most);
/** A bucket and the folder in it, as S3 names one: s3://bucket/folder. */
const bucketUrlSchema = z
  .string()
  .trim()
  .regex(/^s3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9](\/.*)?$/, 'is s3://bucket/folder');

export const backupSettingsSchema = z
  .object({
    /**
     * Where they come from: the environment's ACENTRIC_BACKUP_* until they are set through
     * the API, and what was set then.
     */
    source: z.enum(['environment', 'api']),
    /** Whether the server backs itself up at all. */
    enabled: z.boolean(),
    /** How often one is taken. */
    everyMs: z.number().int().positive(),
    /** How many of each kind are kept. */
    keep: z.number().int().positive(),
    /** The folder they go in, on the server: set in the environment only. */
    dir: z.string(),
    /** The bucket each is copied to as well. Never its secret. */
    bucket: z
      .object({
        url: z.string(),
        /** Where a store that is not S3 is reached. Null for S3. */
        endpoint: z.string().nullable(),
        region: z.string().nullable(),
        /** The access key it is reached with. Null for the environment's own credentials. */
        accessKeyId: z.string().nullable(),
      })
      .nullable(),
    /** When they were set through the API. Null for the environment's. */
    changedAt: timestampSchema.nullable(),
  })
  .meta({ id: 'BackupSettings' });
export type BackupSettings = z.infer<typeof backupSettingsSchema>;

export const setBackupSettingsRequestSchema = z
  .object({
    enabled: z.boolean(),
    everyMs: everyMsSchema,
    keep: keepSchema,
    /** The bucket each is copied to as well, checked first: null for none. */
    bucket: z
      .object({
        url: bucketUrlSchema,
        /** Where a store that is not S3 is reached, such as R2's or MinIO's. Absent for S3. */
        endpoint: z.url({ protocol: /^https?$/ }).nullish(),
        region: z.string().trim().min(1).max(64).nullish(),
        accessKeyId: z.string().trim().min(1).max(256),
        /** Absent to keep the one set before, for the same access key. */
        secretAccessKey: z.string().min(1).max(1024).optional(),
      })
      .nullable(),
  })
  .meta({ id: 'SetBackupSettingsRequest' });
export type SetBackupSettingsRequest = z.infer<typeof setBackupSettingsRequestSchema>;
