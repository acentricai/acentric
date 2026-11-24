// Images a model is shown: what kinds there are, how large one may be, and how a file is
// checked before it is shown.

import type { ImagePart } from '@acentric/protocol';

/** The largest image a model is shown, in bytes. */
export const IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * The longest side, in pixels, of an image a provider takes however many images a request
 * holds. Anthropic takes 8,000 pixels a side, but in a request of more than 20 images it takes
 * fewer, for every image in it, and says to keep to 3,000 for that. An image stays in the
 * conversation, so one the provider refuses would have every call after it refused: it is
 * kept out instead, at the door, while there is still someone to tell.
 */
export const IMAGE_SIDE: { readonly [provider: string]: number } = { anthropic: 3000 };

/** The kind of image a file is, by how it starts. Its name says nothing. */
export function imageTypeOf(bytes: Buffer): string | undefined {
  const starts = (...head: number[]): boolean => head.every((byte, index) => bytes[index] === byte);
  const text = (from: number, to: number): string => bytes.subarray(from, to).toString('latin1');
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (text(0, 6) === 'GIF87a' || text(0, 6) === 'GIF89a') return 'image/gif';
  if (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

/**
 * How large an image is, in pixels, read from how its file starts. Undefined for a file whose
 * size is not where it is looked for: such an image is taken as it is.
 */
export function imageSize(
  bytes: Buffer,
): { readonly width: number; readonly height: number } | undefined {
  const type = imageTypeOf(bytes);
  if (type === 'image/png' && bytes.length >= 24) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (type === 'image/gif' && bytes.length >= 10) {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (type === 'image/webp' && bytes.length >= 30) {
    const kind = bytes.subarray(12, 16).toString('latin1');
    if (kind === 'VP8X') {
      return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    }
    if (kind === 'VP8 ') {
      return { width: bytes.readUInt16LE(26) & 0x3f_ff, height: bytes.readUInt16LE(28) & 0x3f_ff };
    }
    if (kind === 'VP8L') {
      const bits = bytes.readUInt32LE(21);
      return { width: 1 + (bits & 0x3f_ff), height: 1 + ((bits >>> 14) & 0x3f_ff) };
    }
    return undefined;
  }
  if (type === 'image/jpeg') {
    // Its size is in the first frame header, after whatever segments come before it.
    for (let at = 2; at + 9 < bytes.length;) {
      if (bytes[at] !== 0xff) return undefined;
      const marker = bytes[at + 1] ?? 0;
      const frame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (frame) return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
      at += 2 + bytes.readUInt16BE(at + 2);
    }
  }
  return undefined;
}

export const megabytes = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * An image file as the model is shown it, or why it is not shown. `name` is what the model
 * called the file. `provider` is the provider of the model it is shown to.
 */
export function imageOf(
  bytes: Buffer,
  name: string,
  provider: string,
  /** How large the file is, when `bytes` is only the start of it. */
  size = bytes.length,
): { readonly image: ImagePart } | { readonly why: string } {
  if (size > IMAGE_BYTES) {
    return {
      why: `${name} is ${megabytes(size)}, and the largest image that can be shown is ${megabytes(IMAGE_BYTES)}`,
    };
  }
  const mediaType = imageTypeOf(bytes);
  if (mediaType === undefined) return { why: `${name} is not a png, jpeg, gif or webp image` };
  const limit = IMAGE_SIDE[provider];
  const pixels = limit === undefined ? undefined : imageSize(bytes);
  if (
    limit !== undefined &&
    pixels !== undefined &&
    Math.max(pixels.width, pixels.height) > limit
  ) {
    return {
      why: `${name} is ${String(pixels.width)}×${String(pixels.height)} pixels, and the largest image this model can be shown is ${String(limit)} pixels a side. Make a smaller copy, and show that.`,
    };
  }
  return {
    image: { type: 'image', source: { type: 'base64', mediaType, data: bytes.toString('base64') } },
  };
}
