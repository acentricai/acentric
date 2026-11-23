// A bucket the server's backups are copied to, at S3 or at a store that speaks its API (R2,
// MinIO, Backblaze B2, Google Cloud Storage's XML API, and the like): what survives losing the
// server, its disk and everything on it.
//
// What the bucket is reached with is AWS's own: credentials from the environment
// (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY), a profile, a web identity (IRSA, EKS Pod
// Identity), a container's role, or an EC2 instance's role, found as AWS's tools find them. A
// store that is not S3 is reached at AWS_ENDPOINT_URL_S3 (or AWS_ENDPOINT_URL), by path.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

/** Where in a bucket: `s3://<bucket>/<prefix>`. */
export type BucketPlace = {
  /** As given: s3://bucket/prefix. */
  readonly url: string;
  readonly bucket: string;
  /** What each name starts with in it: empty, or ending in a slash. */
  readonly prefix: string;
  /** Where a store that is not S3 is reached. Undefined for S3. */
  readonly endpoint: string | undefined;
  /** The region it is in, when one was given: S3 says so otherwise. */
  readonly region: string | undefined;
};

/** An object in the bucket. */
export type BucketObject = { readonly name: string; readonly bytes: number };

/** A bucket's name, as S3 and the stores like it take one. */
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/**
 * `s3://bucket/some/prefix` as a place in a bucket, or undefined when it is not one. The
 * prefix is a folder of the bucket: it ends in a slash.
 */
export function placeOf(
  url: string,
  env: { readonly [name: string]: string | undefined } = {},
): BucketPlace | undefined {
  const match = /^s3:\/\/([^/]+)(?:\/(.*))?$/.exec(url);
  const bucket = match?.[1];
  if (bucket === undefined || !BUCKET.test(bucket)) return undefined;
  const path = (match?.[2] ?? '').replace(/^\/+|\/+$/g, '');
  const endpoint = (env['AWS_ENDPOINT_URL_S3'] ?? env['AWS_ENDPOINT_URL'])?.trim();
  const region = (env['AWS_REGION'] ?? env['AWS_DEFAULT_REGION'])?.trim();
  return {
    url: `s3://${bucket}${path === '' ? '' : `/${path}`}`,
    bucket,
    prefix: path === '' ? '' : `${path}/`,
    endpoint: endpoint === '' ? undefined : endpoint,
    region: region === '' ? undefined : region,
  };
}

/** Says what went wrong reaching the bucket, in a line. */
function said(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  const message = error.message === '' || error.message === 'UnknownError' ? '' : error.message;
  const code = error.name !== 'Error' && error.name !== message ? error.name : '';
  return (
    [code, message].filter((part) => part !== '').join(': ') ||
    (status === undefined ? 'it did not answer' : `it answered ${String(status)}`)
  );
}

/** What went wrong reaching a bucket. */
export class BucketFailed extends Error {
  override readonly name = 'BucketFailed';
  constructor(place: BucketPlace, doing: string, cause: unknown) {
    super(`${doing} ${place.url} failed: ${said(cause)}`, { cause });
  }
}

export class Bucket {
  readonly place: BucketPlace;
  readonly #client: S3Client;

  constructor(place: BucketPlace) {
    this.place = place;
    this.#client = new S3Client({
      // S3 says which region a bucket is in, when it is asked in another: so one is enough to
      // start with.
      region: place.region ?? 'us-east-1',
      followRegionRedirects: true,
      ...(place.endpoint === undefined ? {} : { endpoint: place.endpoint, forcePathStyle: true }),
      // Only what each request needs: the stores that are not S3 do not all take the rest.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  get url(): string {
    return this.place.url;
  }

  /** Copies the file at `path` to the bucket as `name`, in parts when it is large. */
  async put(path: string, name: string): Promise<void> {
    const { size } = await stat(path);
    // At most 10,000 parts, of 8 MiB at least: a backup of up to 80 GB in the smallest.
    const partSize = Math.max(8 * 1_048_576, Math.ceil(size / 9_000));
    const upload = new Upload({
      client: this.#client,
      params: {
        Bucket: this.place.bucket,
        Key: this.place.prefix + name,
        Body: createReadStream(path),
        ContentType: 'application/x-tar',
      },
      partSize,
      queueSize: 4,
      leavePartsOnError: false,
    });
    try {
      await upload.done();
    } catch (error) {
      throw new BucketFailed(this.place, `Copying ${name} to`, error);
    }
  }

  /** The objects in the bucket under its prefix, but not in folders of it. */
  async list(): Promise<BucketObject[]> {
    const objects: BucketObject[] = [];
    let token: string | undefined;
    try {
      do {
        const page = await this.#client.send(
          new ListObjectsV2Command({
            Bucket: this.place.bucket,
            Prefix: this.place.prefix,
            Delimiter: '/',
            ...(token === undefined ? {} : { ContinuationToken: token }),
          }),
        );
        for (const object of page.Contents ?? []) {
          if (object.Key === undefined) continue;
          objects.push({
            name: object.Key.slice(this.place.prefix.length),
            bytes: object.Size ?? 0,
          });
        }
        token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
      } while (token !== undefined);
    } catch (error) {
      throw new BucketFailed(this.place, 'Listing', error);
    }
    return objects;
  }

  /** Removes `name` from the bucket. */
  async remove(name: string): Promise<void> {
    try {
      await this.#client.send(
        new DeleteObjectCommand({ Bucket: this.place.bucket, Key: this.place.prefix + name }),
      );
    } catch (error) {
      throw new BucketFailed(this.place, `Removing ${name} from`, error);
    }
  }

  /** `name`, read from the bucket: its prefix is the whole of it, here. */
  async read(name: string): Promise<Readable> {
    try {
      const answer = await this.#client.send(
        new GetObjectCommand({ Bucket: this.place.bucket, Key: this.place.prefix + name }),
      );
      return answer.Body as Readable;
    } catch (error) {
      if (error instanceof NoSuchKey) {
        throw new Error(`There is no backup at ${this.place.url}/${name}`, { cause: error });
      }
      throw new BucketFailed(this.place, `Reading ${name} from`, error);
    }
  }

  close(): void {
    this.#client.destroy();
  }
}

/**
 * The object at `s3://bucket/some/name.tar`, read: what the backup commands take in place of
 * a file.
 */
export async function readObject(
  url: string,
  env: { readonly [name: string]: string | undefined },
): Promise<{ readonly input: Readable; close(): void }> {
  const at = url.lastIndexOf('/');
  const place = at > 's3://'.length ? placeOf(url.slice(0, at), env) : undefined;
  const name = url.slice(at + 1);
  if (place === undefined || name === '') {
    throw new Error(`${url} is not an object in a bucket, such as s3://bucket/backups/name.tar`);
  }
  const bucket = new Bucket(place);
  try {
    return { input: await bucket.read(name), close: () => bucket.close() };
  } catch (error) {
    bucket.close();
    throw error;
  }
}
