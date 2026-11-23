// What the pages of links share: a link without its token, which is no link at all.

import { Intro, Step } from '../auth/AuthLayout.tsx';

/** A setup, invite or reset link opened without the token that makes it one. */
export function IncompleteLink({ hint }: { readonly hint: string }) {
  return (
    <Step key="incomplete">
      <Intro title="This link is incomplete">{hint}</Intro>
    </Step>
  );
}
