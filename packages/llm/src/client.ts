// The I/O half of @acentric/llm, for handlers only: it calls providers with
// fetch. It reads keys and the gateway from the handler's secrets, never from
// the environment, so the same code runs on every runner. It also has
// everything in the pure entry, so a handler imports from one place.

export * from './index.js';

export { callProvider, readCredentials } from './client/direct.js';
export type { CallOptions } from './client/direct.js';
export { callGateway, GATEWAY_ROUTE, VERSION_HEADER } from './client/gateway.js';
export type {
  Gateway,
  GatewayCallOptions,
  GatewayEffect,
  GatewayFailure,
  GatewayRequest,
} from './client/gateway.js';
export { createLlm } from './client/llm.js';
export type { LlmClient, LlmContext, LlmOptions } from './client/llm.js';
export { LLM_VERSION } from './version.js';
