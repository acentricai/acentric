// Anthropic failures read into LlmErrors. Anthropic answers
// `{ type: "error", error: { type, message, details? }, request_id }`; a 413
// and errors from its edge have other shapes, or a text body.

import { LlmError } from '../../failure.js';
import type { LlmFailureKind } from '../../failure.js';
import { isObject } from '../../json.js';
import { retryAfter } from '../http.js';
import type { HttpAnswer } from '../http.js';
import { cut } from '../util.js';

const KIND_BY_TYPE: { readonly [type: string]: LlmFailureKind } = {
  authentication_error: 'auth',
  permission_error: 'auth',
  billing_error: 'quota_exceeded',
  not_found_error: 'not_found',
  rate_limit_error: 'rate_limited',
  request_too_large: 'invalid_request',
  overloaded_error: 'overloaded',
  timeout_error: 'timeout',
  api_error: 'provider_error',
};

/** A validation message starts with the field at fault: `messages.1.content.0: …`. */
const FIELD_PREFIX = /^([A-Za-z_][\w-]*(?:\.[\w-]+)*): /;

export function httpFailure(answer: HttpAnswer): LlmError {
  const { body, status, headers } = answer;
  const error = isObject(body) && isObject(body['error']) ? body['error'] : undefined;
  const type = typeof error?.['type'] === 'string' ? error['type'] : undefined;
  const message = typeof error?.['message'] === 'string' ? error['message'] : undefined;
  const details = isObject(error?.['details']) ? error['details'] : undefined;
  const code = typeof details?.['error_code'] === 'string' ? details['error_code'] : undefined;
  const param = message?.match(FIELD_PREFIX)?.[1];
  const after = retryAfter(headers);
  const shouldRetry = headers.get('x-should-retry');
  return new LlmError(
    message ??
      (typeof body === 'string' && body !== '' ? body : undefined) ??
      `the Anthropic call failed with HTTP ${status}`,
    {
      kind: classify(status, type, message, code),
      provider: 'anthropic',
      httpStatus: status,
      providerError: cut(error ?? body),
      ...(code === undefined ? {} : { providerCode: code }),
      ...(type === undefined ? {} : { providerType: type }),
      ...(param === undefined ? {} : { providerParam: param }),
      ...(after === undefined ? {} : { retryAfterMs: after }),
      ...(shouldRetry === 'true'
        ? { retryable: true }
        : shouldRetry === 'false'
          ? { retryable: false }
          : {}),
    },
  );
}

function classify(
  status: number,
  type: string | undefined,
  message: string | undefined,
  code: string | undefined,
): LlmFailureKind {
  // A usage tier's monthly spend cap: a rate limit that lasts until next month.
  if (code === 'enforced_spend_limit_reached') return 'quota_exceeded';
  if (message !== undefined && type === 'invalid_request_error') {
    // "prompt is too long: 205024 tokens > 200000 maximum", with no code.
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
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'quota_exceeded';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status === 503 || status === 529) return 'overloaded';
  if (status === 504) return 'timeout';
  if (status >= 500) return 'provider_error';
  return 'invalid_request';
}
