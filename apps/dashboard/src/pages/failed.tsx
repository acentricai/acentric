// A page that could not be shown: the server could not be reached, or answered with an error.

import { useRouter } from '@tanstack/react-router';

import { errorText } from '../api.ts';
import { AuthFrame, Intro, Step } from '../auth/AuthLayout.tsx';
import { AuthButton } from '../auth/controls.tsx';

export function FailedPage({ error }: { readonly error: unknown }) {
  const router = useRouter();
  return (
    <AuthFrame>
      <Step key="failed">
        <Intro title="This page could not be opened">{errorText(error)}</Intro>
        <AuthButton
          type="button"
          className="auth__submit rise"
          onClick={() => void router.invalidate()}
        >
          Try again
        </AuthButton>
      </Step>
    </AuthFrame>
  );
}
