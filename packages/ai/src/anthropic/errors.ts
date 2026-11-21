// A failure of Anthropic's, read into a ModelFailure. Anthropic answers
// `{ type: "error", error: { type, message, details? } }`; a request too large, and failures
// from before its API, have other shapes, or are text.

import { ModelFailure, cut, kindForStatus } from '../failure.ts';
import type { FailureKind } from '../failure.ts';
import { retryAfter } from '../http.ts';
import type { HttpAnswer } from '../http.ts';
import { isObject } from '../json.ts';
import { PROVIDER } from './request.ts';

const KIND_BY_TYPE: { readonly [type: string]: FailureKind } = {
  authentication_error: 'auth',
  permission_error: 'auth',
  billing_error: 'quota_exceeded',
  not_found_error: 'not_found',
  rate_limit_error: 'rate_limited',
  // Larger than a request may be, in bytes: what makes it smaller is what makes one too long shorter.
  request_too_large: 'context_overflow',
  overloaded_error: 'overloaded',
  timeout_error: 'timeout',
  api_error: 'provider_error',
};

function classify(
  status: number,
  type: string | undefined,
  message: string | undefined,
  code: string | undefined,
): FailureKind {
  // A spending limit for the month: a rate limit that lasts until the next.
  if (code === 'enforced_spend_limit_reached') return 'quota_exceeded';
  if (message !== undefined && type === 'invalid_request_error') {
    if (/^prompt is too long/i.test(message)) return 'context_overflow';
    if (
      /reached your specified (workspace )?API usage limits|credit balance is too low/i.test(
        message,
      )
    ) {
      return 'quota_exceeded';
    }
  }
  const byType = type === undefined ? undefined : KIND_BY_TYPE[type];
  if (byType !== undefined) return byType;
  // From before the API read the request: it is too large.
  if (status === 413) return 'context_overflow';
  return kindForStatus(status);
}

export function httpFailure(
  answer: Pick<HttpAnswer, 'status' | 'headers' | 'body' | 'text'>,
): ModelFailure {
  const { body, status, headers } = answer;
  const error = isObject(body) && isObject(body['error']) ? body['error'] : undefined;
  const type = typeof error?.['type'] === 'string' ? error['type'] : undefined;
  const message = typeof error?.['message'] === 'string' ? error['message'] : undefined;
  const details = isObject(error?.['details']) ? error['details'] : undefined;
  const code = typeof details?.['error_code'] === 'string' ? details['error_code'] : undefined;
  const after = retryAfter(headers);
  // Anthropic says itself, at times, whether the call is worth making again.
  const said = headers.get('x-should-retry');
  const shown = cut(error ?? body);
  return new ModelFailure(
    message ??
      (body === undefined && answer.text !== '' ? answer.text.slice(0, 500) : undefined) ??
      `the Anthropic call failed with HTTP ${String(status)}`,
    classify(status, type, message, code),
    {
      provider: PROVIDER,
      status,
      ...(code === undefined ? {} : { code }),
      ...(shown === undefined ? {} : { detail: shown }),
      ...(after === undefined ? {} : { retryAfterMs: after }),
      ...(said === 'true' ? { retryable: true } : said === 'false' ? { retryable: false } : {}),
    },
  );
}
