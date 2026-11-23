// A reset link: a person sets a new password. Every session of theirs ends with it, so they sign
// in again after. The browser may have someone else signed in: that one stays.

import { PASSWORD_MIN } from '@acentric/protocol';
import { useMutation } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useId, useState } from 'react';

import { api, errorText, isApiError, keys, queryClient } from '../api.ts';
import { AuthFrame, Intro, Step } from '../auth/AuthLayout.tsx';
import { AuthButton, AuthField, AuthToast } from '../auth/controls.tsx';
import { marks, useFailure } from '../auth/failure.ts';
import { Check } from '../auth/icons.tsx';
import { tellOtherTabs } from '../session.ts';
import { IncompleteLink } from './link.tsx';

export const RESET = {
  title: 'Set a new password',
  incomplete: 'Open the whole link you were given.',
  used: 'This link has expired or was used. Ask an admin of this server for a new one.',
  done: 'Password set',
  doneLede: 'Wherever you were signed in, you are signed out. Sign in with your new password.',
};

export function resetError(error: unknown): string {
  if (isApiError(error, 400, 'invalid_link')) return RESET.used;
  return errorText(error);
}

export function ResetPage() {
  const { token } = useSearch({ from: '/reset' });
  const navigate = useNavigate();
  const id = useId();
  const [password, setPassword] = useState('');
  const reset = useMutation({
    mutationFn: (chosen: string) =>
      api.call('password.reset', { body: { token: token ?? '', password: chosen } }),
    onSuccess: () => {
      // Whoever this browser had signed in, if it was them, is signed out now.
      queryClient.removeQueries({ queryKey: keys.me });
      tellOtherTabs();
    },
  });
  const failure = useFailure(reset.error);

  if (token === undefined) {
    return (
      <AuthFrame>
        <IncompleteLink hint={RESET.incomplete} />
      </AuthFrame>
    );
  }
  if (reset.isSuccess) {
    return (
      <AuthFrame>
        <Step key="done">
          <div className="auth__intro rise" role="status">
            <span className="auth__done-mark">
              <Check />
            </span>
            <h1 className="auth__title">{RESET.done}</h1>
            <p className="auth__lede">{RESET.doneLede}</p>
          </div>
          <AuthButton
            type="button"
            className="auth__submit rise"
            onClick={() => void navigate({ to: '/sign-in', replace: true })}
          >
            Sign in
          </AuthButton>
        </Step>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame>
      <Step key="reset">
        <Intro title={RESET.title} />
        <form
          className="auth__form rise"
          onSubmit={(event) => {
            event.preventDefault();
            if (!reset.isPending) reset.mutate(password);
          }}
        >
          <AuthField
            id={`${id}-password`}
            label="New password"
            hint={`${String(PASSWORD_MIN)} characters or more.`}
            type="password"
            autoComplete="new-password"
            required
            autoFocus
            minLength={PASSWORD_MIN}
            maxLength={1024}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            {...marks(reset.error, 'password', `${id}-error`)}
          />
          <AuthButton
            type="submit"
            className="auth__submit"
            busy={reset.isPending}
            disabled={reset.isPending}
          >
            Set password
          </AuthButton>
        </form>
        {failure.shown && (
          <AuthToast id={`${id}-error`} onDismiss={failure.dismiss}>
            {resetError(reset.error)}
          </AuthToast>
        )}
      </Step>
    </AuthFrame>
  );
}
