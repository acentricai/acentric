// A form's refused attempt, shown as a toast until it is dismissed or the form is sent again,
// and the fields it is about, marked.

import { useState } from 'react';

import { ApiError } from '../api.ts';

export type Field = 'email' | 'password' | 'displayName';

/**
 * The fields of a form a refusal is about: those a check of the server's names, a taken email,
 * or both of a sign-in. None for what is not of a field, such as a link that was used.
 */
export function fieldsOf(error: unknown): readonly Field[] {
  if (!(error instanceof ApiError)) return [];
  if (error.code === 'invalid_credentials') return ['email', 'password'];
  if (error.code === 'conflict') return ['email'];
  if (error.code !== 'invalid_request') return [];
  const named = (error.issues ?? []).flatMap((issue) => issue.path ?? []).map(String);
  return (['email', 'password', 'displayName'] as const).filter((field) => named.includes(field));
}

/** What marks a field a refusal is about, and names the toast that says why. */
export function marks(error: unknown, field: Field, errorId: string) {
  return fieldsOf(error).includes(field)
    ? { 'aria-invalid': true, 'aria-errormessage': errorId }
    : {};
}

export function useFailure(error: unknown) {
  const [dismissed, setDismissed] = useState<unknown>(null);
  const shown = error !== null && error !== undefined && dismissed !== error;
  return {
    shown,
    dismiss: () => setDismissed(error),
  };
}
