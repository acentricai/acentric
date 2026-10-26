// The client a handler uses: it finds the gateway or the provider's key in
// the handler's secrets, never in the environment, so the same code runs on
// every runner.
//
// With ACENTRIC_LLM_URL and ACENTRIC_LLM_TOKEN set, a call goes through the
// gateway; otherwise straight to the provider with its key. A provider key
// set alongside the gateway's goes with the call, so the gateway uses it
// instead of its own. Options override all of this.

import type { Secrets } from '@acentric/types';

import { LlmError } from '../failure.js';
import type { Credentials, Provider } from '../providers.js';
import { requestMessages } from '../read.js';
import type { LlmRequest } from '../request.js';
import type { LlmResponse } from '../response.js';
import { GATEWAY_SECRETS, PROVIDER_SECRETS } from '../secrets.js';
import { callProvider } from './direct.js';
import { callGateway } from './gateway.js';
import type { Gateway } from './gateway.js';

/** What the client needs of a handler's context. A HandlerContext is one. */
export type LlmContext = {
  readonly secrets: Secrets;
  /** Stops every call, unless a call passes its own. */
  readonly signal?: AbortSignal;
};

export type LlmOptions = {
  /** Credentials for a provider, used instead of its secret. */
  readonly credentials?: { readonly [P in Provider]?: Credentials<P> };
  /**
   * A gateway to call instead of the one in the secrets, or `false` to call
   * providers directly even when the secrets name one.
   */
  readonly gateway?: Gateway | false;
  /** A fetch to use instead of the global one, such as in tests. */
  readonly fetch?: typeof fetch;
};

export type LlmClient = {
  /**
   * One completion, from the request's provider. The application's `custom`
   * messages are left out. Never retried: on failure it throws an LlmError,
   * which step reads back with `llmFailure`.
   */
  complete<P extends Provider>(
    request: LlmRequest<P>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<LlmResponse<P>>;
};

export function createLlm(context: LlmContext, options: LlmOptions = {}): LlmClient {
  return {
    async complete<P extends Provider>(
      request: LlmRequest<P>,
      call: { readonly signal?: AbortSignal } = {},
    ): Promise<LlmResponse<P>> {
      const signal = call.signal ?? context.signal;
      const callOptions = {
        ...(signal === undefined ? {} : { signal }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      };
      const sent = withoutCustom(request);
      const gateway =
        options.gateway === false
          ? undefined
          : (options.gateway ?? (await gatewayIn(context.secrets)));
      const credentials = await credentialsFor(request.provider, context.secrets, options);
      if (gateway !== undefined) return callGateway(sent, gateway, credentials, callOptions);
      if (credentials !== undefined) return callProvider(sent, credentials, callOptions);
      throw new LlmError(
        `no credentials for ${request.provider}: set the secret ${PROVIDER_SECRETS[request.provider]}, ` +
          `or ${GATEWAY_SECRETS.url} and ${GATEWAY_SECRETS.token} for the gateway`,
        { kind: 'auth', provider: request.provider },
      );
    },
  };
}

/** The request without the application's own messages, which never reach a provider. */
function withoutCustom<P extends Provider>(request: LlmRequest<P>): LlmRequest<P> {
  return { ...request, messages: requestMessages(request.messages) };
}

async function gatewayIn(secrets: Secrets): Promise<Gateway | undefined> {
  const url = await secret(secrets, GATEWAY_SECRETS.url);
  const token = await secret(secrets, GATEWAY_SECRETS.token);
  if (url === undefined && token === undefined) return undefined;
  if (url === undefined || token === undefined) {
    const [set, missing] =
      url === undefined
        ? [GATEWAY_SECRETS.token, GATEWAY_SECRETS.url]
        : [GATEWAY_SECRETS.url, GATEWAY_SECRETS.token];
    throw new LlmError(`${set} is set but ${missing} is not: the gateway needs both`, {
      kind: 'auth',
    });
  }
  return { url, token };
}

async function credentialsFor<P extends Provider>(
  provider: P,
  secrets: Secrets,
  options: LlmOptions,
): Promise<Credentials<P> | undefined> {
  const given: Credentials<P> | undefined = options.credentials?.[provider];
  if (given !== undefined) return given;
  const apiKey = await secret(secrets, PROVIDER_SECRETS[provider]);
  // Every provider's credentials are an apiKey with optional extras.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return apiKey === undefined ? undefined : ({ apiKey } as Credentials<P>);
}

/**
 * A secret's value, or undefined when it is not set. Any other failure to
 * read it is thrown: it must not quietly send the call another way.
 */
async function secret(secrets: Secrets, name: string): Promise<string | undefined> {
  try {
    return await secrets.get(name);
  } catch (error) {
    if (error instanceof Error && error.name === 'SecretNotSet') return undefined;
    throw error;
  }
}
