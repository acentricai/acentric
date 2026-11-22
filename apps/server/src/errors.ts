// What a failed request is answered with: one envelope, with a code from one list.

import { ERROR_STATUS } from '@acentric/protocol';
import type { ErrorCode, ErrorResponse, Issue } from '@acentric/protocol';

/** Something the API itself refuses, before or beside what the engine does. */
export class ApiFailure extends Error {
  override readonly name = 'ApiFailure';
  readonly code: ErrorCode;
  readonly issues: readonly Issue[] | undefined;
  constructor(code: ErrorCode, message: string, issues?: readonly Issue[]) {
    super(message);
    this.code = code;
    this.issues = issues;
  }
}

const isCode = (value: unknown): value is ErrorCode =>
  typeof value === 'string' && Object.hasOwn(ERROR_STATUS, value);

/**
 * The answer to a request that failed. Whatever says the code the API answers it with is
 * answered with that, and what it says of itself. Anything else is the server's own failure:
 * it is told to whoever runs the server, and the answer says nothing of why.
 */
export function failureOf(
  error: unknown,
  requestId: string,
  report: (error: unknown, requestId: string) => void,
): { readonly status: number; readonly body: ErrorResponse } {
  const said = error as { code?: unknown; message?: unknown; issues?: unknown } | null;
  if (error instanceof Error && isCode(said?.code)) {
    const issues = Array.isArray(said.issues) ? (said.issues as Issue[]) : undefined;
    return {
      status: ERROR_STATUS[said.code],
      body: {
        error: {
          code: said.code,
          message: error.message,
          ...(issues === undefined ? {} : { issues }),
          requestId,
        },
      },
    };
  }
  report(error, requestId);
  return {
    status: ERROR_STATUS.internal,
    body: { error: { code: 'internal', message: 'The server failed', requestId } },
  };
}
