// `view_image`: shows the model an image file from the actor's machine. It is a tool of the
// engine's own that answers at once, not a task: it reads the file and the image is its result.

import type {
  Actor,
  AgentDefinition,
  ContentPart,
  ImagePart,
  JsonObject,
} from '@acentric/protocol';

import { MachineNotFound, MachineOffline, MachineRefused } from './machines.ts';
import type { Machines } from './machines.ts';
import type { EngineTool } from './tasks.ts';

/** A tool of the engine's own that answers at once. */
export type OwnTool = {
  readonly tool: EngineTool;
  /** Whether an actor's model is offered it. */
  available(actor: Actor, definition: AgentDefinition): boolean;
  /**
   * Runs it. It is safe to run again: a call that was cut off is made again, with the same
   * `call.id`, by which it can tell that it is the same call.
   */
  run(
    actor: Actor,
    definition: AgentDefinition,
    args: JsonObject,
    call: { readonly id: string },
  ): Promise<{ readonly content: string | readonly ContentPart[]; readonly isError?: boolean }>;
};

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
 * `takesImages` says whether a provider's model reads images: a model of which that is not
 * known is not offered the tool.
 */
export function viewImage(
  machines: Machines,
  takesImages: (provider: string, model: string) => boolean,
): OwnTool {
  return {
    tool: {
      type: 'function',
      name: 'view_image',
      description:
        'Shows you an image file from your machine: a png, jpeg, gif or webp of at most 5 MB.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The file: absolute, from ~, or from your working directory.',
          },
        },
        required: ['path'],
      },
    },

    // For an actor with a machine, whose model takes images.
    available: (actor, definition) =>
      actor.machine !== null && takesImages(definition.provider, actor.modelId),

    async run(actor, definition, args) {
      const failed = (text: string) => ({ content: text, isError: true });
      if (actor.machine === null) return failed('You have no machine');
      const { path, ...rest } = args;
      if (typeof path !== 'string' || path === '') return failed('path is the path of a file');
      const unknown = Object.keys(rest)[0];
      if (unknown !== undefined) return failed(`${unknown} is not known`);
      const { id, cwd } = actor.machine;
      try {
        // A call that an engine before this one was cut off in: the machine may be on its way back.
        await machines.settled(id);
        // One byte more than the most, so that a larger file is known to be one.
        const read = await machines.read(id, { path, cwd, max: IMAGE_BYTES + 1 });
        if (read.size > IMAGE_BYTES) {
          return failed(
            `${path} is ${megabytes(read.size)}, and the largest image that can be shown is ${megabytes(IMAGE_BYTES)}`,
          );
        }
        const bytes = Buffer.from(read.data, 'base64');
        const mediaType = imageTypeOf(bytes);
        if (mediaType === undefined) return failed(`${path} is not a png, jpeg, gif or webp image`);
        const limit = IMAGE_SIDE[definition.provider];
        const size = limit === undefined ? undefined : imageSize(bytes);
        if (
          limit !== undefined &&
          size !== undefined &&
          Math.max(size.width, size.height) > limit
        ) {
          return failed(
            `${path} is ${String(size.width)}×${String(size.height)} pixels, and the largest image this model can be shown is ${String(limit)} pixels a side. Make a smaller copy, and look at that.`,
          );
        }
        const image: ImagePart = {
          type: 'image',
          source: { type: 'base64', mediaType, data: read.data },
        };
        return { content: [image] };
      } catch (error) {
        if (error instanceof MachineRefused) return failed(error.message);
        if (error instanceof MachineOffline) {
          return failed(`Your machine, ${id}, is not connected: the file could not be read.`);
        }
        if (error instanceof MachineNotFound) {
          return failed(`Your machine, ${id}, was removed: the file could not be read.`);
        }
        throw error;
      }
    },
  };
}
