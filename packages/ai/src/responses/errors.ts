// A failure in the Responses format, read into a ModelFailure: from an answer that is not
// 2xx, or from a response that failed and came with HTTP 200.

import type { Json, JsonObject } from '@acentric/protocol';

import { ModelFailure, cut, kindForStatus } from '../failure.ts';
import type { FailureKind } from '../failure.ts';
import { retryAfter } from '../http.ts';
import type { HttpAnswer } from '../http.ts';
import { isArray, isObject } from '../json.ts';
import type { ResponsesProfile } from './profile.ts';

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

const KIND_BY_CODE: { readonly [code: string]: FailureKind } = {
  context_length_exceeded: 'context_overflow',
  model_not_found: 'not_found',
  previous_response_not_found: 'not_found',
  rate_limit_exceeded: 'rate_limited',
  slow_down: 'rate_limited',
  server_is_overloaded: 'overloaded',
  server_error: 'provider_error',
  invalid_api_key: 'auth',
};

type Fields = { readonly message?: string; readonly code?: string; readonly type?: string };

function kindForCode({ code, type }: Fields): FailureKind | undefined {
  if (code !== undefined && POLICY_CODES.has(code)) return 'policy_violation';
  if ((code !== undefined && QUOTA_CODES.has(code)) || type === 'insufficient_quota')
    return 'quota_exceeded';
  return code === undefined ? undefined : KIND_BY_CODE[code];
}

function fieldsOf(detail: Json | undefined): Fields {
  if (!isObject(detail)) return {};
  const { message, code, type } = detail;
  return {
    ...(typeof message === 'string' ? { message } : {}),
    ...(typeof code === 'string' || typeof code === 'number' ? { code: String(code) } : {}),
    ...(typeof type === 'string' ? { type } : {}),
  };
}

/** A list of what is wrong with a request, as some servers write it: `[{ loc, msg }]`. */
function validationErrors(list: readonly Json[]): Fields {
  const message = list
    .filter(isObject)
    .map((entry: JsonObject) => {
      const where = isArray(entry['loc'])
        ? entry['loc'].filter((part) => part !== 'body').join('.')
        : '';
      const said = typeof entry['msg'] === 'string' ? entry['msg'] : '';
      return where === '' ? said : `${where}: ${said}`;
    })
    .filter((text) => text !== '')
    .join('; ');
  return message === '' ? {} : { message };
}

/**
 * The error in an answer. Besides the format's `{ error: {...} }`, some servers answer
 * `{ detail }`: a message, an error, or a list of what is wrong with the request.
 */
function readError(body: Json | undefined): { fields: Fields; detail: Json | undefined } {
  if (isObject(body) && body['error'] === undefined && body['detail'] !== undefined) {
    const detail = body['detail'];
    if (typeof detail === 'string') return { fields: { message: detail }, detail };
    if (isArray(detail)) return { fields: validationErrors(detail), detail };
    return { fields: fieldsOf(detail), detail };
  }
  const detail = isObject(body) && body['error'] !== undefined ? body['error'] : body;
  return { fields: fieldsOf(detail), detail };
}

/** An answer that is not 2xx. */
export function httpFailure(profile: ResponsesProfile, answer: HttpAnswer): ModelFailure {
  const { fields, detail } = readError(answer.body);
  const reading = profile.classify?.({
    ...fields,
    status: answer.status,
    ...(detail === undefined ? {} : { detail }),
  });
  const message =
    reading?.message ??
    fields.message ??
    (answer.body === undefined && answer.text !== '' ? answer.text.slice(0, 500) : undefined) ??
    `the ${profile.label} call failed with HTTP ${String(answer.status)}`;
  const after = retryAfter(answer.headers);
  const shown = cut(detail);
  return new ModelFailure(
    message,
    reading?.kind ?? kindForCode(fields) ?? kindForStatus(answer.status),
    {
      provider: profile.id,
      status: answer.status,
      ...(fields.code === undefined ? {} : { code: fields.code }),
      ...(shown === undefined ? {} : { detail: shown }),
      ...(after === undefined ? {} : { retryAfterMs: after }),
    },
  );
}

/** A response whose status is `failed`, or an error that came with HTTP 200. */
export function failedResponse(profile: ResponsesProfile, error: Json): ModelFailure {
  const { fields, detail } = readError({ error });
  const reading = profile.classify?.({ ...fields, ...(detail === undefined ? {} : { detail }) });
  const kind =
    reading?.kind ??
    kindForCode(fields) ??
    (fields.code === undefined ? 'provider_error' : 'invalid_request');
  const shown = cut(detail);
  return new ModelFailure(
    reading?.message ?? fields.message ?? `the ${profile.label} response failed`,
    kind,
    {
      provider: profile.id,
      ...(fields.code === undefined ? {} : { code: fields.code }),
      ...(shown === undefined ? {} : { detail: shown }),
    },
  );
}
