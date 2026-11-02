// Every way a completion can fail, as an error the client throws and as the
// Json a step reads. An LlmError's toJSON() is what a runner reports as the
// failure's error (docs/reference/runner-spec.md §8), so step learns its kind, whether a retry
// may help and how long to wait. Retrying is the agent's decision.

import type { Json, Outcome } from '@acentric/types';

import { isObject } from './json.js';
import type { Usage } from './usage.js';

/** Whether each kind is worth retrying when the error does not say otherwise. */
const RETRYABLE = {
  /** The client, the gateway or the provider refused the request. */
  invalid_request: false,
  /** Credentials missing, not valid or not allowed. */
  auth: false,
  /** Throttled; see `retryAfterMs`. */
  rate_limited: true,
  /** Out of credits or over a billing limit. */
  quota_exceeded: false,
  /** The prompt is too long for the model. */
  context_overflow: false,
  /** A provider's safety policy refused it; sending it again as it is will not help. */
  policy_violation: false,
  /** An unknown model, or a previous response that expired or is not valid; see `providerParam`. */
  not_found: false,
  /** The provider is out of capacity. */
  overloaded: true,
  /** Any other failure at the provider. */
  provider_error: true,
  /** The provider answered with something that cannot be read. */
  invalid_response: false,
  /** The provider or the gateway could not be reached. */
  network_error: true,
  /** The call took longer than allowed. */
  timeout: true,
  /** The handler's signal fired: the effect was cancelled, aborted or timed out. */
  cancelled: false,
  /** A bug in the gateway. */
  internal_error: false,
} as const satisfies { readonly [kind: string]: boolean };

export type LlmFailureKind = keyof typeof RETRYABLE;

export const LLM_FAILURE_KINDS: readonly LlmFailureKind[] = Object.keys(RETRYABLE).filter(
  (kind): kind is LlmFailureKind => kind in RETRYABLE,
);

/** A failed completion as Json: what an LlmError's toJSON() returns, and what step reads. */
export type LlmFailure = {
  /** Always `LlmError`, which tells an LLM failure from other thrown values. */
  readonly name: 'LlmError';
  readonly message: string;
  readonly kind: LlmFailureKind;
  /** Whether sending the same request again may succeed. */
  readonly retryable: boolean;
  /** Left out for a failure before a provider was chosen. */
  readonly provider?: string;
  readonly providerCode?: string;
  readonly providerType?: string;
  /** The request field the provider blamed, such as `previous_response_id`. */
  readonly providerParam?: string;
  /** The provider's error as it answered, cut short when long. */
  readonly providerError?: Json;
  /** The provider's HTTP status, not the gateway's. */
  readonly httpStatus?: number;
  /** How long the provider asked to wait before trying again, in milliseconds. */
  readonly retryAfterMs?: number;
  /** The provider's request ID, for its support. */
  readonly requestId?: string;
  /** The provider's response ID, when a response was created before it failed. */
  readonly responseId?: string;
  /** Tokens the provider reported, and may bill, for a failed generation. */
  readonly usage?: Usage;
};

type Detail = Omit<LlmFailure, 'name' | 'message' | 'kind' | 'retryable'>;

/** What an LlmError is made from. `retryable` defaults by kind. */
export type LlmErrorOptions = Detail & {
  readonly kind: LlmFailureKind;
  readonly retryable?: boolean;
};

const DETAIL: readonly (keyof Detail)[] = [
  'provider',
  'providerCode',
  'providerType',
  'providerParam',
  'providerError',
  'httpStatus',
  'retryAfterMs',
  'requestId',
  'responseId',
  'usage',
];

/** A failed completion. The client throws it; a runner reports its toJSON() to step. */
export class LlmError extends Error {
  override readonly name = 'LlmError';
  readonly failure: LlmFailure;

  constructor(message: string, options: LlmErrorOptions) {
    super(message);
    const { kind, retryable, ...detail } = options;
    const failure: { [key: string]: Json | undefined } = {
      name: 'LlmError',
      message,
      kind,
      retryable: retryable ?? RETRYABLE[kind],
    };
    for (const key of DETAIL) if (detail[key] !== undefined) failure[key] = detail[key];
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    this.failure = failure as LlmFailure;
  }

  get kind(): LlmFailureKind {
    return this.failure.kind;
  }

  get retryable(): boolean {
    return this.failure.retryable;
  }

  /** The failure as Json, which a runner reports as the effect's error. */
  toJSON(): LlmFailure {
    return this.failure;
  }

  /** An LlmError from its Json, such as a gateway's answer. */
  static fromJSON({ message, kind, retryable, ...detail }: LlmFailure): LlmError {
    const options: LlmErrorOptions = { ...omitName(detail), kind, retryable };
    return new LlmError(message, options);
  }
}

function omitName(detail: Detail & { readonly name?: string }): Detail {
  const { name: _name, ...rest } = detail;
  return rest;
}

/** Whether a value is an LlmFailure, such as a failed effect's error. */
export function isLlmFailure(value: Json | undefined): value is LlmFailure {
  if (!isObject(value)) return false;
  const { name, message, kind, retryable } = value;
  return (
    name === 'LlmError' &&
    typeof message === 'string' &&
    typeof kind === 'string' &&
    kind in RETRYABLE &&
    typeof retryable === 'boolean'
  );
}

/**
 * The LLM failure in an effect's outcome, or null: for a result, for a
 * failure the runner reported itself (a timeout, a crash) and for one thrown
 * by something other than this package.
 */
export function llmFailure(outcome: Outcome): LlmFailure | null {
  if (!('failed' in outcome)) return null;
  const { error } = outcome.failed;
  return isLlmFailure(error) ? error : null;
}
