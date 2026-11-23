// An invite: a person someone on the server asked in makes their account, with the role the
// invite gives. An invite is used once; one whose email turned out to be taken can be used again.

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

export const INVITE = {
  title: 'Join Acentric',
  lede: 'You were invited to this server. Make your account to sign in.',
  incomplete: 'Open the whole link you were sent.',
  used: 'This invite has expired, was used or was withdrawn. Ask whoever sent it for a new one.',
  taken: 'There is an account with this email already. Sign in with it, or use another email.',
};

export function inviteError(error: unknown): string {
  if (isApiError(error, 400, 'invalid_link')) return INVITE.used;
  if (isApiError(error, 409, 'conflict')) return INVITE.taken;
  return errorText(error);
}

export function InvitePage() {
  const { token } = useSearch({ from: '/invite' });
  const navigate = useNavigate();
  const id = useId();
  const accept = useMutation({
    mutationFn: (account: Account) =>
      api.call('invites.accept', {
        body: { ...account, token: token ?? '', client: 'dashboard' },
      }),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: keys.me });
      tellOtherTabs();
      await navigate({ to: '/', replace: true });
    },
  });
  const failure = useFailure(accept.error);

  return (
    <AuthFrame>
      {token === undefined ? (
        <IncompleteLink hint={INVITE.incomplete} />
      ) : (
        <Step key="invite">
          <Intro title={INVITE.title}>{INVITE.lede}</Intro>
          <AccountForm
            submit="Create account"
            busy={accept.isPending}
            error={accept.error}
            errorId={`${id}-error`}
            onSubmit={(account) => accept.mutate(account)}
          />
          {failure.shown && (
            <AuthToast id={`${id}-error`} onDismiss={failure.dismiss}>
              {inviteError(accept.error)}
            </AuthToast>
          )}
        </Step>
      )}
    </AuthFrame>
  );
}
