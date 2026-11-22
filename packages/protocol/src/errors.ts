// How the API says a request failed. Every failure is answered with the same envelope, and a
// code from one list. A client decides what to do by the code, and shows a person the message.

import { z } from 'zod';

/** Every code a failure can have, and the HTTP status it is answered with. */
export const ERROR_STATUS = {
  /** The request is not one the route takes: its body, its query or a path parameter. */
  invalid_request: 400,
  /** No credential came with the request, or one that is not known, was revoked or has expired. */
  unauthenticated: 401,
  /** The email and the password are not a person's who can sign in. */
  invalid_credentials: 401,
  /** The credential does not reach what the request is about, or lacks the permission it takes. */
  forbidden: 403,
  /** There is no such thing, or none the credential can see. */
  not_found: 404,
  /** What the request asks cannot be done as things stand. */
  conflict: 409,
  /** The name is another's. */
  name_taken: 409,
  /** The request is larger than the route takes. */
  too_large: 413,
  /** Too many requests: try again later. */
  rate_limited: 429,
  /** The server failed. The message says nothing of why. */
  internal: 500,
  /** The server cannot do this now, and may be able to later. */
  unavailable: 503,

  /** A link that was to be used once is not known, was used, was revoked or has expired. */
  invalid_link: 400,

  /** The deployed code was built for a protocol this engine does not run. */
  unsupported_protocol: 400,
  /** The deployed code is not an agent, or does not load. */
  invalid_agent: 400,
  /** The deployed code uses what this engine does not have: a provider, or a feature. */
  unsupported_feature: 400,
  /** An actor's configuration failed its agent's schema. */
  invalid_configuration: 400,
  /** An input's payload failed its schema. */
  invalid_input: 400,
  /** The agent has no input of that type. */
  unknown_input: 400,
  /** The actor is in a turn, and this is done only between turns. */
  actor_busy: 409,
  /** The actor is archived, and takes nothing until it is unarchived. */
  actor_archived: 409,
  /** A model provider refused or failed a call made for this request. */
  provider_failed: 502,
  /** The machine's daemon is not connected. Nothing was sent to it. */
  machine_offline: 409,
  /** The machine's daemon refused what was asked of it. */
  machine_refused: 400,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export const ERROR_CODES = Object.keys(ERROR_STATUS) as [ErrorCode, ...ErrorCode[]];

export const errorCodeSchema = z.enum(ERROR_CODES);

/** One thing wrong with what was given, and where in it. */
export const issueSchema = z.object({
  message: z.string(),
  /** The way to the value at fault, from the top of what was given. */
  path: z.array(z.union([z.string(), z.number()])).optional(),
});

export type Issue = z.infer<typeof issueSchema>;

/** What every failed request is answered with. */
export const errorResponseSchema = z
  .object({
    error: z.object({
      code: errorCodeSchema,
      /** For a person. It may change: a client decides by `code`. */
      message: z.string(),
      /** For a request that failed a schema: each thing wrong with it. */
      issues: z.array(issueSchema).optional(),
      /** The server's ID for the request, to find it in the server's logs by. */
      requestId: z.string().optional(),
    }),
  })
  .meta({ id: 'Error', description: 'What every failed request is answered with.' });

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/** The HTTP status a failure of `code` is answered with. */
export function statusOf(code: ErrorCode): number {
  return ERROR_STATUS[code];
}
