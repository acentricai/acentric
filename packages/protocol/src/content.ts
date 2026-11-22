// Content every provider shares: what a user's message, a system message and a tool's result
// are made of. Small on purpose: what one provider adds goes in a part's `providerOptions`.

import { z } from 'zod';

import { jsonSchema } from './json.ts';

/**
 * Fields merged as they are into the provider's own block for a shared shape, such as a cache
 * marker on a content part. Nothing but the provider's own code reads them.
 */
export const providerFieldsSchema = z.record(z.string(), jsonSchema);
export type ProviderFields = z.infer<typeof providerFieldsSchema>;

/** The application's own attributes on a part or message. Never sent to a provider. */
export const metadataSchema = z.record(z.string(), jsonSchema);
export type Metadata = z.infer<typeof metadataSchema>;

/** The name of a blob: the SHA-256 of its bytes, as 64 hex characters. */
export const blobDigestSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'A blob is named by the SHA-256 of its bytes, as 64 hex characters')
  .meta({ description: "A blob's name: the SHA-256 of its bytes, in hex." });
export type BlobDigest = z.infer<typeof blobDigestSchema>;

/**
 * Where an image or file comes from.
 *
 * An agent's code gives bytes as `base64`. An engine that has a blob store keeps them apart
 * from the conversation, and the message has a `blob` in their place: the bytes are read from
 * the actor they are of (see the route `blobs.get`), and put back when the model is called.
 */
export const mediaSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('url'), url: z.url() }),
  z.object({
    type: z.literal('base64'),
    /** An IANA media type, such as `image/png` or `application/pdf`. */
    mediaType: z.string().min(1),
    data: z.string(),
  }),
  z.object({
    /** Bytes the engine keeps, named by their digest. An actor names only blobs of its own. */
    type: z.literal('blob'),
    digest: blobDigestSchema,
    mediaType: z.string().min(1),
    /** How many bytes it is. */
    size: z.number().int().nonnegative(),
  }),
  z.object({
    /** A file in the provider's own storage. Works only with the provider that issued it. */
    type: z.literal('file_id'),
    id: z.string().min(1),
  }),
]);
export type MediaSource = z.infer<typeof mediaSourceSchema>;

const partBase = {
  /** Merged into the provider's block for this part. */
  providerOptions: providerFieldsSchema.optional(),
  metadata: metadataSchema.optional(),
};

export const textPartSchema = z.object({ type: z.literal('text'), text: z.string(), ...partBase });
export type TextPart = z.infer<typeof textPartSchema>;

export const imagePartSchema = z.object({
  type: z.literal('image'),
  source: mediaSourceSchema,
  ...partBase,
});
export type ImagePart = z.infer<typeof imagePartSchema>;

/** A document, such as a PDF. */
export const filePartSchema = z.object({
  type: z.literal('file'),
  source: mediaSourceSchema,
  filename: z.string().min(1).optional(),
  ...partBase,
});
export type FilePart = z.infer<typeof filePartSchema>;

/** A part of a user's message or of a tool's result. */
export const contentPartSchema = z
  .discriminatedUnion('type', [textPartSchema, imagePartSchema, filePartSchema])
  .meta({ id: 'ContentPart' });
export type ContentPart = z.infer<typeof contentPartSchema>;
