// Where a person lands once signed in. It stands in for the dashboard's own pages, which come
// after the pages of signing in: it says who is signed in, and signs them out.

import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';

import { api, meQuery, queryClient } from '../api.ts';
import { AuthFrame, Intro, Step } from '../auth/AuthLayout.tsx';
import { AuthButton } from '../auth/controls.tsx';
import { tellOtherTabs } from '../session.ts';

export function HomePage() {
  const navigate = useNavigate();
  const me = useQuery(meQuery);
  const signOut = useMutation({
    // Signed out here whatever the server says: the cookie it clears is its own to clear.
    mutationFn: () => api.call('auth.signOut').catch(() => undefined),
    onSettled: async () => {
      queryClient.clear();
      tellOtherTabs();
      await navigate({ to: '/sign-in', replace: true });
    },
  });
  const email = me.data?.type === 'user' ? me.data.email : '';

  return (
    <AuthFrame>
      <Step key="home">
        <Intro title="Signed in">
          <span className="auth__who">{email}</span>
        </Intro>
        <AuthButton
          type="button"
          secondary
          className="auth__submit rise"
          busy={signOut.isPending}
          disabled={signOut.isPending}
          onClick={() => signOut.mutate()}
        >
          Sign out
        </AuthButton>
      </Step>
    </AuthFrame>
  );
}
