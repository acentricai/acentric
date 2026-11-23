// Blobs: the images and files of conversations, with their bytes kept apart.
//
// An agent's code gives an image as bytes in base64. Left in its message, they are in the
// database row, in memory for every actor that is awake, and in every list of messages the
// API answers. So the bytes are kept in a blob store, named by their own digest, and the
// message has a reference in their place. They are put back when the model is called.
//
// A blob is of the actors that refer to it. It is removed when the last of them is gone, and
// at no other time: nothing is removed for its age.
//
// What is where, in which order:
//
// - Kept: the bytes are written first, then the store is told the actor refers to them. Bytes
//   that were written and never referred to are removed when the engine next starts.
// - Removed: the store forgets the blob first, then the bytes are removed.
//
// So a blob the store knows always has its bytes. Keeping and removing are done one at a time,
// so that bytes being removed are not at the same moment found there by something keeping
// them.

import { createHash } from 'node:crypto';

import type { ActorId, ContentPart, MediaSource, Message } from '@acentric/protocol';

import { EngineError } from './errors.ts';
import type { Store, StoredBlob } from './store.ts';

/**
 * Where the bytes of blobs are, by name. A name is the SHA-256 of the bytes, in hex, so the
 * same bytes are kept once, and what is kept under a name never changes.
 */
export interface BlobStore {
  /** Keeps bytes under their name. Bytes that are there already are left as they are. */
  put(digest: string, bytes: Uint8Array): Promise<void>;
  /** The bytes of a name. Undefined when there are none. */
  get(digest: string): Promise<Uint8Array | undefined>;
  /** Removes the bytes of a name, if they are there. */
  remove(digest: string): Promise<void>;
  /** Every name there are bytes under. */
  list(): Promise<string[]>;
}

/** A blob store in memory, for tests and for an engine that keeps nothing. */
export class MemoryBlobStore implements BlobStore {
  readonly #bytes = new Map<string, Uint8Array>();

  async put(digest: string, bytes: Uint8Array): Promise<void> {
    // A copy that is its own, and no view of what a caller may go on to change.
    if (!this.#bytes.has(digest)) this.#bytes.set(digest, new Uint8Array(bytes));
  }

  async get(digest: string): Promise<Uint8Array | undefined> {
    return this.#bytes.get(digest);
  }

  async remove(digest: string): Promise<void> {
    this.#bytes.delete(digest);
  }

  async list(): Promise<string[]> {
    return [...this.#bytes.keys()];
  }
}

/** Content names a blob its actor does not refer to: one of another actor's, or none at all. */
export class UnknownBlob extends EngineError {
  override readonly name = 'UnknownBlob';
  readonly code = 'invalid_request';
  constructor(digest: string) {
    super(`The content names a blob this actor has none of: ${digest}`);
  }
}

/** A blob the store knows has no bytes: the blob store is not the one they were kept in. */
export class BlobMissing extends Error {
  override readonly name = 'BlobMissing';
  constructor(digest: string) {
    super(`The bytes of the blob ${digest} are not in the blob store`);
  }
}

type Media = Extract<ContentPart, { readonly source: MediaSource }>;

const hasMedia = (content: readonly { readonly type: string }[], source: string): boolean =>
  content.some((part) => (part as Partial<Media>).source?.type === source);

export class Blobs {
  readonly #store: Store;
  readonly #bytes: BlobStore | undefined;
  readonly #clock: () => number;
  /** The last thing that was kept or removed: the next waits for it. */
  #last: Promise<unknown> = Promise.resolve();
  /** How many backups are copying blobs now: while any is, none is removed. */
  #holds = 0;
  /** Whether removing was asked for while it was held back: done once it is let go. */
  #owed = false;

  constructor(options: {
    readonly store: Store;
    /** Where the bytes go. Without it, bytes stay in their messages, as they were given. */
    readonly bytes?: BlobStore;
    readonly clock?: () => number;
  }) {
    this.#store = options.store;
    this.#bytes = options.bytes;
    this.#clock = options.clock ?? Date.now;
  }

  /** Whether bytes are kept apart at all. */
  get enabled(): boolean {
    return this.#bytes !== undefined;
  }

  /**
   * Content as it is kept in an actor's conversation: every image and file that was given as
   * bytes has a reference in their place, and the bytes are in the blob store.
   *
   * Content may name a blob the actor refers to already, as a tool does that gives back an
   * image it was shown. Naming any other is refused with `UnknownBlob`: an actor is never
   * shown what another's conversation has.
   */
  async keep(actor: ActorId, content: ContentPart[]): Promise<ContentPart[]> {
    if (!hasMedia(content, 'blob') && (!hasMedia(content, 'base64') || !this.enabled)) {
      return content;
    }
    const kept: ContentPart[] = [];
    for (const part of content) {
      if (part.type === 'text') kept.push(part);
      else kept.push({ ...part, source: await this.#kept(actor, part.source) });
    }
    return kept;
  }

  async #kept(actor: ActorId, source: MediaSource): Promise<MediaSource> {
    const store = this.#bytes;
    if (source.type === 'blob') {
      const known =
        store === undefined ? undefined : await this.#store.blobOf(actor, source.digest);
      if (known === undefined) throw new UnknownBlob(source.digest);
      // Its size is what was kept, whatever the content says of it.
      return { ...source, size: known.size };
    }
    if (source.type !== 'base64' || store === undefined) return source;
    const bytes = Buffer.from(source.data, 'base64');
    const blob: StoredBlob = {
      digest: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.byteLength,
      mediaType: source.mediaType,
      createdAt: this.#clock(),
    };
    await this.#alone(async () => {
      await store.put(blob.digest, bytes);
      await this.#store.addBlob(actor, blob);
    });
    return { type: 'blob', digest: blob.digest, mediaType: blob.mediaType, size: blob.size };
  }

  /**
   * Messages as a model is sent them: every blob with its bytes in its place. A blob is read
   * once for a call, however often the conversation names it. Messages with no blob are given
   * back as they are.
   */
  async withBytes(messages: readonly Message[]): Promise<readonly Message[]> {
    const store = this.#bytes;
    const read = new Map<string, Promise<string>>();
    const dataOf = (digest: string): Promise<string> => {
      let data = read.get(digest);
      if (data === undefined) {
        data = (async () => {
          const bytes = await store?.get(digest);
          if (bytes === undefined) throw new BlobMissing(digest);
          return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
        })();
        read.set(digest, data);
      }
      return data;
    };
    const filled = async <P extends ContentPart>(part: P): Promise<P> => {
      if (part.type === 'text' || part.source.type !== 'blob') return part;
      const { digest, mediaType } = part.source;
      return { ...part, source: { type: 'base64', mediaType, data: await dataOf(digest) } };
    };
    return Promise.all(
      messages.map(async (message) => {
        if (message.role === 'user' || message.role === 'tool_result') {
          if (!hasMedia(message.content, 'blob')) return message;
          return { ...message, content: await Promise.all(message.content.map(filled)) };
        }
        if (message.role === 'system' && hasMedia(message.content, 'blob')) {
          return { ...message, content: await Promise.all(message.content.map(filled)) };
        }
        return message;
      }),
    );
  }

  /** A blob an actor refers to, with its bytes. Undefined when it refers to none of that name. */
  async read(
    actor: ActorId,
    digest: string,
  ): Promise<{ readonly blob: StoredBlob; readonly bytes: Uint8Array } | undefined> {
    const blob = await this.#store.blobOf(actor, digest);
    if (blob === undefined) return undefined;
    const bytes = await this.#bytes?.get(digest);
    if (bytes === undefined) throw new BlobMissing(digest);
    return { blob, bytes };
  }

  /**
   * Removes every blob that no actor refers to any more: called once actors are gone. It
   * gives how many were removed.
   */
  collect(): Promise<number> {
    return this.#alone(async () => {
      // A backup is copying what the store refers to: removing waits until it is done.
      if (this.#holds > 0) {
        this.#owed = true;
        return 0;
      }
      const gone = await this.#store.dropUnreferencedBlobs();
      for (const digest of gone) await this.#bytes?.remove(digest);
      return gone.length;
    });
  }

  /**
   * Puts the blob store right when an engine starts: what `collect` would remove, and bytes
   * the store knows nothing of, which a process that died between writing them and saying so
   * left behind. It gives how many were removed.
   */
  sweep(): Promise<number> {
    return this.#alone(async () => {
      const store = this.#bytes;
      if (store === undefined) return 0;
      const gone = new Set(await this.#store.dropUnreferencedBlobs());
      const known = new Set(await this.#store.listBlobs());
      for (const digest of await store.list()) if (!known.has(digest)) gone.add(digest);
      for (const digest of gone) await store.remove(digest);
      return gone.size;
    });
  }

  /**
   * Does `work` with no blob removed while it is done: what a backup copies the blobs in. New
   * blobs are kept meanwhile as ever. It starts once whatever was being kept or removed is done,
   * and what was to be removed while it went on is removed after it.
   */
  async withoutRemovals<T>(work: () => Promise<T>): Promise<T> {
    await this.#alone(async () => {
      this.#holds += 1;
    });
    try {
      return await work();
    } finally {
      this.#holds -= 1;
      if (this.#holds === 0 && this.#owed) {
        this.#owed = false;
        void this.collect().catch(() => {});
      }
    }
  }

  /** Does one thing after whatever was being kept or removed is done. */
  #alone<T>(work: () => Promise<T>): Promise<T> {
    const done = this.#last.then(work, work);
    this.#last = done.catch(() => {});
    return done;
  }
}
