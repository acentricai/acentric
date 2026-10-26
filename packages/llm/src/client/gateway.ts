// One call through the acentric gateway, which acentric-cloud runs. The
// request goes as it is, with the token in a header and any provider
// credentials the caller has in the body; the response comes back as it is.

import { isLlmFailure, LlmError } from '../failure.js';
import type { LlmFailure } from '../failure.js';
import { isObject } from '../json.js';
import type { Credentials, Provider } from '../providers.js';
import type { LlmRequest } from '../request.js';
import type { LlmResponse } from '../response.js';
import type { CallOptions } from './direct.js';
import { postJson, retryAfter } from './http.js';
import type { HttpAnswer } from './http.js';
import { kindForStatus } from './responses/errors.js';
import { cut, invalidResponse } from './util.js';

/** Where a gateway takes completions, under its URL. */
export const GATEWAY_ROUTE = '/v1/complete';

/**
 * The body of a call to the gateway: the request, and the caller's own
 * credentials for its provider, which the gateway uses instead of its own.
 */
export type GatewayRequest<P extends Provider = Provider> = P extends Provider
  ? LlmRequest<P> & { readonly credentials?: Credentials<P> }
  : never;

/** The body of a gateway's answer that is not 2xx. */
export type GatewayFailure = { readonly error: LlmFailure };

export type Gateway = {
  /** The gateway's address, such as `https://llm.cloud.acentric.dev`. */
  readonly url: string;
  /** Sent as `Authorization: Bearer`. */
  readonly token: string;
};

export async function callGateway<P extends Provider>(
  request: LlmRequest<P>,
  gateway: Gateway,
  credentials: Credentials<P> | undefined,
  { signal, fetch }: CallOptions = {},
): Promise<LlmResponse<P>> {
  const provider = request.provider;
  const answer = await postJson({
    provider,
    label: 'the acentric gateway',
    url: `${base(provider, gateway.url)}${GATEWAY_ROUTE}`,
    headers: { authorization: `Bearer ${gateway.token}` },
    body: credentials === undefined ? request : { ...request, credentials },
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    ...(signal === undefined ? {} : { signal }),
    ...(fetch === undefined ? {} : { fetch }),
    failed: (http) => gatewayFailure(provider, http),
    // The gateway's request ID is not the provider's; its failures carry that.
    providerAnswers: false,
  });
  const body = answer.body;
  const message = isObject(body) ? body['message'] : undefined;
  if (!isObject(body) || body['provider'] !== provider || !isObject(message)) {
    throw invalidResponse(provider, 'the acentric gateway did not answer with a response', body);
  }
  // The gateway answers what callProvider returned, for this provider.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return body as unknown as LlmResponse<P>;
}

/** The gateway's own failure as it sent it, or one read from the HTTP status. */
function gatewayFailure(provider: Provider, answer: HttpAnswer): LlmError {
  const error = isObject(answer.body) ? answer.body['error'] : undefined;
  if (isLlmFailure(error)) return LlmError.fromJSON(error);
  const after = retryAfter(answer.headers);
  return new LlmError(`the acentric gateway answered HTTP ${answer.status}`, {
    kind: kindForStatus(answer.status),
    provider,
    httpStatus: answer.status,
    providerError: cut(answer.body),
    ...(after === undefined ? {} : { retryAfterMs: after }),
  });
}

function base(provider: Provider, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LlmError(`the gateway's URL is not a URL: ${value}`, {
      kind: 'invalid_request',
      provider,
    });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new LlmError('the gateway must be reached over https, or http for local development', {
      kind: 'invalid_request',
      provider,
    });
  }
  return url.href.replace(/\/+$/, '');
}
