// Open records of Json: fields a shape passes through without interpreting.

import type { Json } from '@acentric/types';

/**
 * Fields merged as they are into the provider's own block for a shared shape,
 * such as Anthropic's `cache_control` on a content part or OpenAI's `detail`
 * on an image. The client never interprets them.
 */
export type ProviderFields = { readonly [key: string]: Json };

/** The application's own attributes on a part or message. Never sent to a provider. */
export type Metadata = { readonly [key: string]: Json };
