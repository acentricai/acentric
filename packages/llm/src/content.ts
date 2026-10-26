// Content shared by every provider: what user messages, system messages and
// tool results are made of. Small on purpose; anything one provider adds goes
// in a part's `providerOptions`.

import type { Metadata, ProviderFields } from './fields.js';

/** Where an image or file comes from. */
export type MediaSource =
  | { readonly type: 'url'; readonly url: string }
  | {
      readonly type: 'base64';
      /** An IANA media type, such as `image/png` or `application/pdf`. */
      readonly mediaType: string;
      readonly data: string;
    }
  | {
      /** A file in the provider's own storage. Works only with the provider that issued it. */
      readonly type: 'file_id';
      readonly id: string;
    };

type PartBase = {
  /** Merged into the provider's block for this part. */
  readonly providerOptions?: ProviderFields;
  readonly metadata?: Metadata;
};

export type TextPart = PartBase & {
  readonly type: 'text';
  readonly text: string;
};

export type ImagePart = PartBase & {
  readonly type: 'image';
  readonly source: MediaSource;
};

/** A document, such as a PDF. */
export type FilePart = PartBase & {
  readonly type: 'file';
  readonly source: MediaSource;
  readonly filename?: string;
};

/** Content of user messages and tool results. */
export type ContentPart = TextPart | ImagePart | FilePart;
