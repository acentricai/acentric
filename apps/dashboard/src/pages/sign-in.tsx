// Sign in: an email and a password. A first sign-in is not here: the first person is made by the
// setup link the server prints, and everyone after by an invite.

import { useMutation } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useId, useState } from 'react';

import { api, errorText, isApiError, keys, queryClient } from '../api.ts';
import { AuthFrame, Intro, Step } from '../auth/AuthLayout.tsx';
import { AuthButton, AuthField, AuthToast } from '../auth/controls.tsx';
import { marks, useFailure } from '../auth/failure.ts';
import { tellOtherTabs } from '../session.ts';

export const SIGN_IN = {
  wrong: 'That email and password do not match.',
  forgot: 'Forgot your password? An admin of this server can give you a link to set a new one.',
};

/** Why signing in failed, in the page's words or the server's. */
export function signInError(error: unknown): string {
  if (isApiError(error, 401, 'invalid_credentials')) return SIGN_IN.wrong;
  // How long to wait is the server's to say.
  return errorText(error);
}

export function SignInPage() {
  const { redirect } = useSearch({ from: '/sign-in' });
  const navigate = useNavigate();
  const id = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const signIn = useMutation({
    mutationFn: (given: { email: string; password: string }) =>
      api.call('auth.signIn', { body: { ...given, client: 'dashboard' } }),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: keys.me });
      tellOtherTabs();
      await navigate({ href: redirect ?? '/', replace: true });
    },
  });
  const failure = useFailure(signIn.error);

  return (
    <AuthFrame>
      <Step key="sign-in">
        <Intro title="Sign in" center />
        <form
          className="auth__form rise"
          onSubmit={(event) => {
            event.preventDefault();
            if (!signIn.isPending) signIn.mutate({ email: email.trim(), password });
          }}
        >
          <AuthField
            id={`${id}-email`}
            label="Email"
            type="email"
            inputMode="email"
            autoComplete="username"
            required
            autoFocus
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            {...marks(signIn.error, 'email', `${id}-error`)}
          />
          <AuthField
            id={`${id}-password`}
            label="Password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={1024}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            {...marks(signIn.error, 'password', `${id}-error`)}
          />
          <AuthButton
            type="submit"
            className="auth__submit"
            busy={signIn.isPending}
            disabled={signIn.isPending}
          >
            Sign in
          </AuthButton>
        </form>
        <p className="auth__aside rise">{SIGN_IN.forgot}</p>
        {failure.shown && (
          <AuthToast id={`${id}-error`} onDismiss={failure.dismiss}>
            {signInError(signIn.error)}
          </AuthToast>
        )}
      </Step>
    </AuthFrame>
  );
}
