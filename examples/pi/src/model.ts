// What step knows about a model. The catalog of models is code bundled with
// the agent, as in pi, so updating it means a new version of the agent.

import type { ModelRef } from './content.js';

export type ModelInfo = ModelRef & {
  name: string;
  /** The most tokens the model can take in, input and output together. */
  contextWindow: number;
  /** The most tokens it can produce in one reply. */
  maxTokens: number;
  /** Whether it accepts images as well as text. */
  images: boolean;
  /** Whether it can think before answering, so thinking levels apply. */
  reasoning: boolean;
};
