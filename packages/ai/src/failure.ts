// Why a call of a model failed, as far as what to do about it goes.

import type { Json } from '@acentric/protocol';

export type FailureKind =
  /** Too many calls: the same call may work later. */
  | 'rate_limited'
  /** The provider cannot take the call now. */
  | 'overloaded'
  /** The call did not reach the provider, or its answer did not come back. */
  | 'network'
  /** The provider took too long, or went quiet. */
  | 'timeout'
  /** The provider failed, in a way that is its own. */
  | 'provider_error'
  /** The provider answered with what is not an answer. */
  | 'invalid_response'
  /** The credential was refused. */
  | 'auth'
  /** The account has used what it may: the same call is refused until that changes. */
  | 'quota_exceeded'
  /** The provider refused the call as it is: the same call will be refused again. */
  | 'invalid_request'
  /** The conversation is longer than the model reads. */
  | 'context_overflow'
  /** The provider refused the call for what it asks. */
  | 'policy_violation'
  /** There is no such model, or no such thing the call names. */
  | 'not_found'
  | 'other';

/** The kinds a call may get past by being made again later. */
const PASSING: readonly FailureKind[] = [
  'rate_limited',
  'overloaded',
  'network',
  'timeout',
  'provider_error',
];

export type FailureDetails = {
  /** How long the provider said to wait before the call is made again. */
  readonly retryAfterMs?: number;
  /** Said when the provider said so itself, whatever the kind would mean. */
  readonly retryable?: boolean;
  readonly provider?: string;
  /** The HTTP status the provider answered with. */
  readonly status?: number;
  /** The provider's own code for the failure. */
  readonly code?: string;
  /** The error as the provider wrote it, cut short. */
  readonly detail?: Json;
};

/** A call of a model failed. */
export class ModelFailure extends Error {
  override readonly name = 'ModelFailure';
  readonly kind: FailureKind;
  /** Whether the same call, made again later, may work. */
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly provider: string | undefined;
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly detail: Json | undefined;

  constructor(message: string, kind: FailureKind, details: FailureDetails = {}) {
    super(message);
    this.kind = kind;
    this.retryable = details.retryable ?? PASSING.includes(kind);
    this.retryAfterMs = details.retryAfterMs;
    this.provider = details.provider;
    this.status = details.status;
    this.code = details.code;
    this.detail = details.detail;
  }
}

/** The kind an HTTP status means when nothing more is known. */
export function kindForStatus(status: number): FailureKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'quota_exceeded';
  if (status === 404) return 'not_found';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status === 503 || status === 529) return 'overloaded';
  if (status >= 500) return 'provider_error';
  return 'invalid_request';
}

/** An error as a provider wrote it, short enough to keep. */
export function cut(detail: Json | undefined): Json | undefined {
  if (detail === undefined) return undefined;
  const text = JSON.stringify(detail);
  return text.length <= 2000 ? detail : `${text.slice(0, 2000)}…`;
}
