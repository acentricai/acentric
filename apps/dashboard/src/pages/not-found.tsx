import { Link } from '@tanstack/react-router';

import { AuthFrame, Intro, Step } from '../auth/AuthLayout.tsx';

export function NotFoundPage() {
  return (
    <AuthFrame>
      <Step key="not-found">
        <Intro title="There is no such page">
          <Link to="/" className="auth__link">
            Go to the start
          </Link>
        </Intro>
      </Step>
    </AuthFrame>
  );
}
