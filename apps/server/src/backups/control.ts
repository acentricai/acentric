// How the server backs itself up, and the backups that are taken so: the environment's
// ACENTRIC_BACKUP_EVERY, ACENTRIC_BACKUP_KEEP and ACENTRIC_BACKUP_URL until they are set
// through the API, and then those, kept in the database, the bucket's secret sealed. Set, they
// take the place of the backups there were without a restart: the old are closed, once the one
// being taken is, and the new started. The folder they go in is the environment's always: a
// path on the server is not the API's to choose.

import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sealedFor } from '@acentric/core';
import type { Audit, Secrets, Store, StoredBackupSettings } from '@acentric/core';
import type { BackupSettings, PrincipalRef, SetBackupSettingsRequest } from '@acentric/protocol';

import { ApiFailure } from '../errors.ts';
import type { BackupSettings as EnvBackups } from '../settings.ts';
import { Bucket, placeOf } from './bucket.ts';
import type { BucketCredentials, BucketPlace } from './bucket.ts';
import type { Backups } from './schedule.ts';

/** How often, and how many, when the environment says neither: as the settings' own. */
const EVERY_MS = 86_400_000;
const KEEP = 3;

/** How the server backs itself up, from wherever that is said. */
export type Effective = {
  readonly enabled: boolean;
  readonly everyMs: number;
  readonly keep: number;
  readonly bucket:
    | { readonly place: BucketPlace; readonly credentials: BucketCredentials | undefined }
    | undefined;
};

/** The environment's: off is not enabled, and says how often and how many all the same. */
export function fromEnvironment(env: EnvBackups | undefined): Effective {
  if (env === undefined)
    return { enabled: false, everyMs: EVERY_MS, keep: KEEP, bucket: undefined };
  return {
    enabled: true,
    everyMs: env.everyMs,
    keep: env.keep,
    bucket: env.bucket === undefined ? undefined : { place: env.bucket, credentials: undefined },
  };
}

/** Those set through the API, the bucket's secret opened with `open`. */
export function fromStored(
  stored: StoredBackupSettings,
  open: (sealed: string) => string,
): Effective {
  const { bucket } = stored;
  const place =
    bucket === null
      ? undefined
      : placeOf(bucket.url, {
          ...(bucket.endpoint === null ? {} : { AWS_ENDPOINT_URL_S3: bucket.endpoint }),
          ...(bucket.region === null ? {} : { AWS_REGION: bucket.region }),
        });
  return {
    enabled: stored.enabled,
    everyMs: stored.everyMs,
    keep: stored.keep,
    bucket:
      bucket === null || place === undefined
        ? undefined
        : {
            place,
            credentials: { accessKeyId: bucket.accessKeyId, secretAccessKey: open(bucket.secret) },
          },
  };
}

/** Opens a bucket's secret as it was sealed. */
export const openBucketSecret = (secrets: Pick<Secrets, 'open'>) => (sealed: string) =>
  secrets.open(sealedFor.backupBucket(), sealed, "The backups' bucket's secret");

export class BackupControl {
  readonly #store: Store;
  readonly #secrets: Secrets;
  readonly #audit: Audit;
  readonly #dir: string;
  readonly #env: EnvBackups | undefined;
  readonly #make: (effective: Effective) => Backups;
  readonly #log: (line: string) => void;
  #stored: StoredBackupSettings | undefined;
  #current: Backups | undefined;
  /** A change being made: the next waits for it. */
  #changing: Promise<unknown> = Promise.resolve();
  #started = false;
  #closed = false;

  constructor(options: {
    readonly store: Store;
    readonly secrets: Secrets;
    readonly audit: Audit;
    /** The folder they go in. */
    readonly dir: string;
    /** The environment's settings. Undefined for ACENTRIC_BACKUP_EVERY=off. */
    readonly env: EnvBackups | undefined;
    /** Backups as they are taken so, not yet started. */
    readonly make: (effective: Effective) => Backups;
    readonly log?: (line: string) => void;
  }) {
    this.#store = options.store;
    this.#secrets = options.secrets;
    this.#audit = options.audit;
    this.#dir = options.dir;
    this.#env = options.env;
    this.#make = options.make;
    this.#log = options.log ?? (() => {});
  }

  /** The backups taken now. Undefined while they are off. */
  get current(): Backups | undefined {
    return this.#current;
  }

  /** Reads what was set through the API, and makes the backups so. They are not started yet. */
  async load(): Promise<void> {
    this.#stored = await this.#store.loadBackupSettings();
    const effective = this.#effective();
    this.#current = effective.enabled ? this.#make(effective) : undefined;
  }

  /** Starts the backups there are. */
  async start(): Promise<void> {
    this.#started = true;
    await this.#current?.start();
  }

  /** How they are set now. Never the bucket's secret. */
  settings(): BackupSettings {
    const stored = this.#stored;
    if (stored === undefined) {
      const env = fromEnvironment(this.#env);
      return {
        source: 'environment',
        enabled: env.enabled,
        everyMs: env.everyMs,
        keep: env.keep,
        dir: this.#dir,
        bucket:
          env.bucket === undefined
            ? null
            : {
                url: env.bucket.place.url,
                endpoint: env.bucket.place.endpoint ?? null,
                region: env.bucket.place.region ?? null,
                accessKeyId: null,
              },
        changedAt: null,
      };
    }
    return {
      source: 'api',
      enabled: stored.enabled,
      everyMs: stored.everyMs,
      keep: stored.keep,
      dir: this.#dir,
      bucket:
        stored.bucket === null
          ? null
          : {
              url: stored.bucket.url,
              endpoint: stored.bucket.endpoint,
              region: stored.bucket.region,
              accessKeyId: stored.bucket.accessKeyId,
            },
      changedAt: stored.changedAt,
    };
  }

  /**
   * Sets them, in place of the environment's or those set before: a bucket is checked first,
   * by writing to it and removing what was written. One change at a time.
   */
  configure(asked: SetBackupSettingsRequest, by: PrincipalRef): Promise<BackupSettings> {
    const done = this.#changing.then(
      () => this.#configure(asked, by),
      () => this.#configure(asked, by),
    );
    this.#changing = done.catch(() => {});
    return done;
  }

  async #configure(asked: SetBackupSettingsRequest, by: PrincipalRef): Promise<BackupSettings> {
    if (this.#closed) throw new ApiFailure('unavailable', 'The server is stopping');
    const bucket = asked.bucket === null ? null : await this.#bucketOf(asked.bucket);
    const stored: StoredBackupSettings = {
      enabled: asked.enabled,
      everyMs: asked.everyMs,
      keep: asked.keep,
      bucket,
      changedAt: Date.now(),
      changedBy: by.type === 'system' ? null : by.id,
    };
    await this.#store.saveBackupSettings(stored);
    this.#stored = stored;
    await this.#audit.record({
      by,
      action: 'backup.configured',
      detail: {
        enabled: stored.enabled,
        everyMs: stored.everyMs,
        keep: stored.keep,
        ...(bucket === null ? {} : { bucket: bucket.url }),
      },
    });

    // The backups taken so from now on: those there were finish the one they are taking.
    const before = this.#current;
    const effective = this.#effective();
    this.#current = effective.enabled ? this.#make(effective) : undefined;
    await before?.close();
    if (this.#started) await this.#current?.start();
    this.#log(
      effective.enabled
        ? `backups are taken every ${String(effective.everyMs / 60_000)} minutes, as set through the API`
        : 'backups are off, as set through the API',
    );
    return this.settings();
  }

  /** The bucket as it is kept: reached first, and its secret sealed. */
  async #bucketOf(
    asked: NonNullable<SetBackupSettingsRequest['bucket']>,
  ): Promise<NonNullable<StoredBackupSettings['bucket']>> {
    const endpoint = asked.endpoint ?? null;
    const region = asked.region ?? null;
    const before = this.#stored?.bucket ?? null;
    let secret: string;
    if (asked.secretAccessKey !== undefined) {
      secret = asked.secretAccessKey;
    } else if (before !== null && before.accessKeyId === asked.accessKeyId) {
      secret = openBucketSecret(this.#secrets)(before.secret);
    } else {
      throw new ApiFailure(
        'invalid_request',
        'secretAccessKey is the secret of the access key, and is needed for a key not set before',
      );
    }
    const place = placeOf(asked.url, {
      ...(endpoint === null ? {} : { AWS_ENDPOINT_URL_S3: endpoint }),
      ...(region === null ? {} : { AWS_REGION: region }),
    });
    if (place === undefined) {
      throw new ApiFailure('invalid_request', `${asked.url} is not a bucket: s3://bucket/folder`);
    }
    await reach(new Bucket(place, { accessKeyId: asked.accessKeyId, secretAccessKey: secret }));
    return {
      url: place.url,
      endpoint,
      region,
      accessKeyId: asked.accessKeyId,
      secret: this.#secrets.seal(sealedFor.backupBucket(), secret),
    };
  }

  #effective(): Effective {
    const stored = this.#stored;
    if (stored === undefined) return fromEnvironment(this.#env);
    try {
      return fromStored(stored, openBucketSecret(this.#secrets));
    } catch (error) {
      // Backups are taken all the same, to the folder: a server is not kept from starting
      // by a bucket.
      this.#log(
        `backups are not copied to ${stored.bucket?.url ?? 'the bucket'}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return fromStored({ ...stored, bucket: null }, () => '');
    }
  }

  /** No backup is started from now on, and one being taken is finished first. */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#changing;
    await this.#current?.close();
  }
}

/** Writes a small file to the bucket and removes it: that backups can be copied there. */
async function reach(bucket: Bucket): Promise<void> {
  const folder = await mkdtemp(join(tmpdir(), 'acentric-bucket-'));
  const name = `.acentric-check-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(
      join(folder, name),
      'This is written to check that backups can be copied here.\n',
    );
    await bucket.list();
    await bucket.put(join(folder, name), name);
    await bucket.remove(name);
  } catch (error) {
    throw new ApiFailure(
      'conflict',
      `The bucket is not reached: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    bucket.close();
    await rm(folder, { recursive: true, force: true });
  }
}
