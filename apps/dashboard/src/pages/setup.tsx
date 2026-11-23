// The setup link: the first person of a server makes their account, and owns it. The server
// prints this link when it starts with no one in it, and a new one at each start until then.

import { useMutation } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useId } from 'react';

import { api, errorText, isApiError, keys, queryClient } from '../api.ts';
import { AccountForm } from '../auth/AccountForm.tsx';
import type { Account } from '../auth/AccountForm.tsx';
import { AuthFrame, Intro, Step } from '../auth/AuthLayout.tsx';
import { AuthToast } from '../auth/controls.tsx';
import { useFailure } from '../auth/failure.ts';
import { tellOtherTabs } from '../session.ts';
import { IncompleteLink } from './link.tsx';

export const SETUP = {
  title: 'Set up Acentric',
  lede: 'You are the first person here. The account you make owns this server.',
  incomplete: 'Open the whole link the server printed when it started.',
  used: 'This setup link has expired or was used. While no one has an account, the server prints a new one each time it starts.',
};

export function setupError(error: unknown): string {
  if (isApiError(error, 400, 'invalid_link')) return SETUP.used;
  return errorText(error);
}

export function SetupPage() {
  const { token } = useSearch({ from: '/setup' });
  const navigate = useNavigate();
  const id = useId();
  const setup = useMutation({
    mutationFn: (account: Account) =>
      api.call('setup.complete', {
        body: { ...account, token: token ?? '', client: 'dashboard' },
      }),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: keys.me });
      tellOtherTabs();
      await navigate({ to: '/', replace: true });
    },
  });
  const failure = useFailure(setup.error);

  return (
    <AuthFrame>
      {token === undefined ? (
        <IncompleteLink hint={SETUP.incomplete} />
      ) : (
        <Step key="setup">
          <Intro title={SETUP.title}>{SETUP.lede}</Intro>
          <AccountForm
            submit="Create account"
            busy={setup.isPending}
            error={setup.error}
            errorId={`${id}-error`}
            onSubmit={(account) => setup.mutate(account)}
          />
          {failure.shown && (
            <AuthToast id={`${id}-error`} onDismiss={failure.dismiss}>
              {setupError(setup.error)}
            </AuthToast>
          )}
        </Step>
      )}
    </AuthFrame>
  );
}
