// Responses failures read into LlmErrors: from an HTTP error, or from a
// failed response that came with HTTP 200.

import type { Json, JsonObject } from '@acentric/types';

import { LlmError } from '../../failure.js';
import type { LlmFailureKind } from '../../failure.js';
import { isArray, isObject } from '../../json.js';
import type { Usage } from '../../usage.js';
import { retryAfter } from '../http.js';
import type { HttpAnswer } from '../http.js';
import { cut, show } from '../util.js';
import type { ErrorInput, ResponsesProfile, ResponsesProvider } from './profile.js';

const POLICY_CODES: ReadonlySet<string> = new Set([
  'bio_policy',
  'cyber_policy',
  'misalignment_policy_violation',
  'image_content_policy_violation',
]);

const QUOTA_CODES: ReadonlySet<string> = new Set([
  'insufficient_quota',
  'credit_balance_exhausted',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
]);

const KIND_BY_CODE: { readonly [code: string]: LlmFailureKind } = {
  context_length_exceeded: 'context_overflow',
  previous_response_not_found: 'not_found',
  rate_limit_exceeded: 'rate_limited',
  slow_down: 'rate_limited',
  server_is_overloaded: 'overloaded',
  server_error: 'provider_error',
  vector_store_timeout: 'timeout',
};

/** The kind an HTTP status means when nothing more is known. */
export function kindForStatus(status: number): LlmFailureKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'quota_exceeded';
  if (status === 404) return 'not_found';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status === 503 || status === 529) return 'overloaded';
  if (status >= 500) return 'provider_error';
  return 'invalid_request';
}

type Fields = {
  readonly message?: string;
  readonly code?: string;
  readonly type?: string;
  readonly param?: string;
};

/** A provider's answer that is not 2xx, as an LlmError. */
export function httpFailure<P extends ResponsesProvider>(
  profile: ResponsesProfile<P>,
  answer: HttpAnswer,
): LlmError {
  const { fields, detail } = readError(answer.body);
  const input: ErrorInput = { ...fields, status: answer.status };
  const reading = profile.classifyError?.(input);
  const message =
    fields.message ??
    (typeof answer.body === 'string' && answer.body !== '' ? answer.body : undefined) ??
    `the ${profile.label} call failed with HTTP ${answer.status}`;
  const param = fields.param ?? reading?.param;
  const after = retryAfter(answer.headers);
  return new LlmError(message, {
    kind: reading?.kind ?? kindForCode(fields) ?? kindForStatus(answer.status),
    provider: profile.provider,
    httpStatus: answer.status,
    providerError: cut(detail),
    ...(fields.code === undefined ? {} : { providerCode: fields.code }),
    ...(fields.type === undefined ? {} : { providerType: fields.type }),
    ...(param === undefined ? {} : { providerParam: param }),
    ...(after === undefined ? {} : { retryAfterMs: after }),
  });
}

/** A response whose status is `failed`, or an error that came with HTTP 200. */
export function failedResponse<P extends ResponsesProvider>(
  profile: ResponsesProfile<P>,
  error: Json,
  responseId: string | undefined,
  usage: Usage | undefined,
): LlmError {
  const { fields, detail } = readError({ error });
  const reading = profile.classifyError?.(fields);
  const param = fields.param ?? reading?.param;
  return new LlmError(fields.message ?? `the ${profile.label} response failed`, {
    kind:
      reading?.kind ??
      kindForCode(fields) ??
      (fields.code === undefined ? 'provider_error' : 'invalid_request'),
    provider: profile.provider,
    providerError: cut(detail),
    ...(fields.code === undefined ? {} : { providerCode: fields.code }),
    ...(param === undefined ? {} : { providerParam: param }),
    ...(responseId === undefined ? {} : { responseId }),
    ...(usage === undefined ? {} : { usage }),
  });
}

function kindForCode({ code, type }: Fields): LlmFailureKind | undefined {
  if (code !== undefined && POLICY_CODES.has(code)) return 'policy_violation';
  if ((code !== undefined && QUOTA_CODES.has(code)) || type === 'insufficient_quota') {
    return 'quota_exceeded';
  }
  return code === undefined ? undefined : KIND_BY_CODE[code];
}

/**
 * The error in an answer. Besides the format's `{ error: {...} }`, Fireworks
 * also answers FastAPI's `{ detail }`: a message, an error, or a list of
 * validation errors.
 */
function readError(body: Json): { fields: Fields; detail: Json } {
  if (isObject(body) && body['error'] === undefined && body['detail'] !== undefined) {
    const detail = body['detail'];
    if (typeof detail === 'string') return { fields: { message: detail }, detail };
    if (isArray(detail)) return { fields: validationErrors(detail), detail };
    return { fields: errorFields(detail), detail };
  }
  const detail = isObject(body) && body['error'] !== undefined ? body['error'] : body;
  return { fields: errorFields(detail), detail };
}

function errorFields(detail: Json): Fields {
  if (!isObject(detail)) return {};
  const { message, code, type, param } = detail;
  return {
    ...(typeof message === 'string' ? { message } : {}),
    ...(typeof code === 'string' || typeof code === 'number' ? { code: String(code) } : {}),
    ...(typeof type === 'string' ? { type } : {}),
    ...(typeof param === 'string' ? { param } : {}),
  };
}

/** FastAPI's validation errors: `[{ loc: ["body", "temperature"], msg }]`. */
function validationErrors(list: readonly Json[]): Fields {
  const entries = list.filter(isObject).map((entry: JsonObject) => {
    const loc = entry['loc'];
    const msg = entry['msg'];
    const path = isArray(loc)
      ? loc
          .filter((part) => part !== 'body')
          .map((part) => show(part))
          .join('.')
      : '';
    return { param: path, message: typeof msg === 'string' ? msg : '' };
  });
  const message = entries
    .map((entry) => (entry.param === '' ? entry.message : `${entry.param}: ${entry.message}`))
    .filter((text) => text !== '')
    .join('; ');
  const only = entries.length === 1 ? entries[0]?.param : undefined;
  return {
    ...(message === '' ? {} : { message }),
    ...(only === undefined || only === '' ? {} : { param: only }),
  };
}
