// How step reads a failed model reply: a context overflow, an error worth
// retrying, or neither. The patterns are pi's (packages/ai/src/utils/overflow.ts
// and retry.ts); providers word these errors in many ways.

import type { AssistantMessage } from './content.js';
import type { RetrySettings } from './config.js';

const OVERFLOW_PATTERNS = [
  /prompt (?:is )?too long/i,
  /prompt exceeds max length/i,
  /request_too_large/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
  /input token count.*exceeds the maximum/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /too large for model with \d+ maximum context length/i,
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i,
  /model_context_window_exceeded/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /range of input length should be/i,
  /context[_ ]length[_ ]exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
  /^(?:[\w -]+ API error \(413\):|413(?:\s|:|$))/i,
];

const CEREBRAS_BODYLESS_OVERFLOW_PATTERN = /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i;

const NON_OVERFLOW_PATTERNS = [
  /^(Throttling error|Service unavailable):/i,
  /rate limit/i,
  /too many requests/i,
];

/**
 * Whether a reply failed because the context was too large: an error saying
 * so, or a provider that truncated the input to fill the window and had no
 * room left to answer.
 */
export function isContextOverflow(message: AssistantMessage, contextWindow: number): boolean {
  const error = message.errorMessage;
  if (message.stopReason === 'error' && error !== undefined) {
    if (!NON_OVERFLOW_PATTERNS.some((pattern) => pattern.test(error))) {
      if (OVERFLOW_PATTERNS.some((pattern) => pattern.test(error))) return true;
      if (message.provider === 'cerebras' && CEREBRAS_BODYLESS_OVERFLOW_PATTERN.test(error))
        return true;
    }
  }
  if (message.stopReason === 'length' && message.usage.output === 0) {
    return message.usage.input + message.usage.cacheRead >= contextWindow * 0.99;
  }
  return false;
}

const NON_RETRYABLE_PATTERN = new RegExp(
  [
    'GoUsageLimitError',
    'FreeUsageLimitError',
    'Monthly usage limit reached',
    'available balance',
    'insufficient_quota',
    'out of budget',
    'quota exceeded',
    'billing',
    'subscription_sharing_usage_limit_exceeded',
    'subscription_sharing_workplace_individual_usage_limit_exceeded',
  ].join('|'),
  'i',
);

const RETRYABLE_PATTERN = new RegExp(
  [
    'overloaded',
    'server_busy',
    'servers are currently busy',
    'currently experiencing high demand',
    'model is at capacity',
    'rate.?limit',
    'too many requests',
    '(?<![a-z0-9])(?:429|500|502|503|504|520|524)(?![a-z0-9])',
    'service.?(?:is.?)?(?:temporarily.?)?unavailable',
    'server.?error',
    'internal.?error',
    'provider.?returned.?(?:an.?)?error',
    'exceeded request buffer limit while retrying upstream',
    'unable to forward upstream',
    'upstream.?request.?failed',
    'upstream_stream_read_error',
    'stream was interrupted',
    'http/?2 stream failed',
    'network.?error',
    'connection.?error',
    'connection.?refused',
    'connection.?lost',
    'other side closed',
    'fetch failed',
    'request to \\S+ failed, reason:',
    'getaddrinfo',
    'ENOTFOUND',
    'EAI_AGAIN',
    'upstream.?connect',
    'reset before headers',
    'socket hang up',
    'socket connection was closed',
    'timed? out',
    'timeout',
    'terminated',
    'websocket.?closed',
    'websocket.?error',
    'ended without',
    'stream ended before message_stop',
    'stream ended before a terminal response event',
    'http2 request did not get a response',
    'stream disconnected before completion',
    'pending stream has been canceled',
    'retry delay',
    'you can retry your request',
    'try your request again',
    'please retry your request',
    'ResourceExhausted',
    'subscription_sharing_usage_unavailable',
    'subscription_sharing_user_unavailable',
  ].join('|'),
  'i',
);

/** Whether a failed reply looks like a passing provider or network problem. Check overflow first. */
export function isRetryable(message: AssistantMessage): boolean {
  const error = message.errorMessage;
  if (message.stopReason !== 'error' || error === undefined) return false;
  if (NON_RETRYABLE_PATTERN.test(error)) return false;
  return RETRYABLE_PATTERN.test(error);
}

/** How long to wait before retry number `attempt`, counting from 1. */
export function retryDelayMs(retry: RetrySettings, attempt: number): number {
  const delay = retry.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(Number.isSafeInteger(delay) ? delay : Number.MAX_SAFE_INTEGER, retry.maxDelayMs);
}
