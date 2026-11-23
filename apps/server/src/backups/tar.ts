// A backup is a tar archive, so that the tools there are everywhere read it: `tar -tf` lists
// it, and it is streamed through a pipe, `docker exec` and `kubectl exec`. Only what a backup
// has is written and read: regular files under short names. A size of 8 GiB or more is written
// as GNU tar writes it, in base 256, which every tar of the last twenty years reads.

import type { Readable, Writable } from 'node:stream';

const BLOCK = 512;
/** The largest size the 11 octal digits of the size field hold. */
const OCTAL_SIZE_MAX = 0o77777777777;

/** One file of an archive, as it is read. */
export type Entry = { readonly name: string; readonly size: number };

const ascii = (text: string, length: number): Buffer => {
  const bytes = Buffer.alloc(length);
  bytes.write(text, 'ascii');
  return bytes;
};

const octal = (value: number, length: number): Buffer =>
  ascii(`${value.toString(8).padStart(length - 1, '0')}\0`, length);

function sizeField(size: number): Buffer {
  if (size <= OCTAL_SIZE_MAX) return octal(size, 12);
  // Base 256: the first byte's top bit set, the size in the rest, most significant first.
  const field = Buffer.alloc(12);
  let rest = BigInt(size);
  for (let at = 11; at > 0; at -= 1) {
    field[at] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  field[0] = 0x80;
  return field;
}

/** The header of a regular file. */
export function header(name: string, size: number, mtime: number): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error(`${name} is too long a name for an archive`);
  const block = Buffer.alloc(BLOCK);
  ascii(name, 100).copy(block, 0);
  octal(0o644, 8).copy(block, 100);
  octal(0, 8).copy(block, 108);
  octal(0, 8).copy(block, 116);
  sizeField(size).copy(block, 124);
  octal(Math.floor(mtime / 1000), 12).copy(block, 136);
  // The checksum is of the header with its own field as spaces.
  block.fill(0x20, 148, 156);
  block.write('0', 156, 'ascii');
  ascii('ustar\0', 6).copy(block, 257);
  ascii('00', 2).copy(block, 263);
  let sum = 0;
  for (const byte of block) sum += byte;
  ascii(`${sum.toString(8).padStart(6, '0')}\0 `, 8).copy(block, 148);
  return block;
}

/** What a file of `size` bytes is padded with, to a whole block. */
export const padding = (size: number): Buffer => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

/** Two blocks of zeros: the end of an archive. */
export const END = Buffer.alloc(BLOCK * 2);

/** Writes bytes, waiting while the stream is full. */
export async function write(out: Writable, bytes: Uint8Array): Promise<void> {
  if (out.write(bytes)) return;
  await new Promise<void>((resolve, reject) => {
    const drained = () => {
      out.off('error', failed);
      resolve();
    };
    const failed = (error: Error) => {
      out.off('drain', drained);
      reject(error);
    };
    out.once('drain', drained);
    out.once('error', failed);
  });
}

function sizeOf(field: Buffer): number {
  const first = field[0] ?? 0;
  if ((first & 0x80) !== 0) {
    let size = BigInt(first & 0x7f);
    for (let at = 1; at < field.length; at += 1) size = (size << 8n) | BigInt(field[at] ?? 0);
    if (size > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error('A file of the archive is too large');
    return Number(size);
  }
  const text = field.toString('ascii').replace(/\0.*$/s, '').trim();
  if (!/^[0-7]+$/.test(text)) throw new Error('The archive has a header with no size');
  return Number.parseInt(text, 8);
}

function checked(block: Buffer): Entry {
  const stored = Number.parseInt(block.toString('ascii', 148, 156).replace(/\0.*$/s, '').trim(), 8);
  let sum = 0;
  for (let at = 0; at < BLOCK; at += 1) sum += at >= 148 && at < 156 ? 0x20 : (block[at] ?? 0);
  if (stored !== sum) throw new Error('The archive is damaged: a header does not add up');
  const type = String.fromCharCode(block[156] ?? 0);
  if (type !== '0' && type !== '\0') {
    throw new Error('The archive has something that is not a file in it: it is no backup');
  }
  const name = block.toString('utf8', 0, 100).replace(/\0.*$/s, '');
  return { name, size: sizeOf(block.subarray(124, 136)) };
}

/**
 * Reads an archive: `file` is called for each file, with its bytes as they come, and must
 * take all of them before the next is read. It rejects an archive that ends before its end.
 */
export async function readArchive(
  input: Readable,
  file: (entry: Entry, chunks: AsyncIterable<Buffer>) => Promise<void>,
): Promise<void> {
  const source = input[Symbol.asyncIterator]() as AsyncIterator<Buffer | string>;
  let held = Buffer.alloc(0);
  let ended = false;
  /** At least `count` bytes, or fewer only where the input ends. */
  const fill = async (count: number): Promise<void> => {
    while (held.length < count && !ended) {
      const next = await source.next();
      if (next.done === true) ended = true;
      else held = Buffer.concat([held, Buffer.from(next.value)]);
    }
  };
  const take = async (count: number): Promise<Buffer> => {
    await fill(count);
    if (held.length < count) throw new Error('The archive ends before its end: it is cut off');
    const taken = held.subarray(0, count);
    held = held.subarray(count);
    return taken;
  };

  for (;;) {
    const block = await take(BLOCK);
    if (block.every((byte) => byte === 0)) {
      // The end: a second block of zeros, and nothing after it but padding.
      const second = await take(BLOCK);
      if (!second.every((byte) => byte === 0)) throw new Error('The archive is damaged at its end');
      return;
    }
    const entry = checked(block);
    let left = entry.size;
    async function* chunks(): AsyncGenerator<Buffer> {
      while (left > 0) {
        await fill(1);
        if (held.length === 0) throw new Error('The archive ends before its end: it is cut off');
        const part = held.subarray(0, Math.min(left, held.length));
        held = held.subarray(part.length);
        left -= part.length;
        yield part;
      }
    }
    await file(entry, chunks());
    // What the reader did not take is passed over.
    for await (const _ of chunks()) void _;
    await take((BLOCK - (entry.size % BLOCK)) % BLOCK);
  }
}
