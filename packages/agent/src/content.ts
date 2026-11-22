// What a tool returns and what an input becomes: text, or parts. A part is text, an image, or
// a file such as a PDF, each from a URL, from base64, or from a file the provider keeps.

import type { ContentPart } from '@acentric/protocol';

export type { ContentPart, FilePart, ImagePart, MediaSource, TextPart } from '@acentric/protocol';

/** Text alone, or parts in order. */
export type Content = string | readonly ContentPart[];
