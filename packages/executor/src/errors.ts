// What is wrong with code that was given to be run as an agent.

import type { ErrorCode } from '@acentric/protocol';

/** The code is not an agent: it does not load, exports none, or says what no agent is. */
export class BundleError extends Error {
  override readonly name: string = 'BundleError';
  readonly code: ErrorCode = 'invalid_agent';
}

/** The code was built for a bundle protocol this engine does not run. */
export class UnsupportedProtocol extends BundleError {
  override readonly name = 'UnsupportedProtocol';
  override readonly code: ErrorCode = 'unsupported_protocol';
  constructor(protocol: unknown, supported: readonly number[]) {
    super(
      `The code speaks bundle protocol ${String(protocol)}, and this engine runs ${supported.join(', ')}`,
    );
  }
}
