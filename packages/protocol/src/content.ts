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

/** Where an image or file comes from. */
export const mediaSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('url'), url: z.url() }),
  z.object({
    type: z.literal('base64'),
    /** An IANA media type, such as `image/png` or `application/pdf`. */
    mediaType: z.string().min(1),
    data: z.string(),
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
