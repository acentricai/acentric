// Signing in at a provider whose accounts have no key: the person signs in at the provider's
// page in their own browser, and gives back what it ends with, which finishes the sign-in on the
// engine and makes the account. Closing the dialog gives the sign-in up.
//
//   ChatGPT  As OpenAI's Sign in with ChatGPT has it for an open-source application: its page
//            sends the browser to an address on the person's own computer. Nothing is there,
//            so that page does not load, and its address is what is pasted.
//   Claude   As Claude Code signs in on a machine with no browser: Claude's page shows a code,
//            and the code is what is pasted. Only on a server that has Claude.

import { IconBrandOpenai, IconExternalLink, IconLogin } from '@tabler/icons-react';
import type { Account, SignIn, StartSignInRequest } from '@acentric/protocol';
import { useMutation } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

import { queryClient } from '../api.ts';
import { displayText } from '../machines/text.tsx';
import { Button, buttonClass, Dialog, Field, FormError } from '../machines/ui.tsx';
import { engine } from './api.ts';
import type { SignInProvider } from './format.ts';
import { keys } from './queries.ts';

/** What differs between the providers that are signed in to. */
type Kind = {
  readonly button: string;
  readonly icon: ReactNode;
  /** Said of the first step: signing in at the provider's page. */
  readonly signInAt: string;
  /** Said of the second: what to paste. */
  readonly paste: string;
  readonly field: string;
  readonly placeholder: string;
  /** Whether what was pasted is whole, and so sent at once: a code lasts only a little while. */
  readonly whole: (pasted: string) => boolean;
  /** Any other attributes of the button, as the provider asks for them. */
  readonly attributes?: { readonly [name: string]: string };
};

const KINDS: { readonly [provider in SignInProvider]: Kind } = {
  chatgpt: {
    button: 'Sign in with ChatGPT',
    icon: <IconBrandOpenai size={16} stroke={1.75} aria-hidden="true" />,
    signInAt: 'Sign in to ChatGPT on OpenAI’s page.',
    paste: 'The page it sends you to does not load. Paste its address here.',
    field: 'Address',
    placeholder: 'http://127.0.0.1:1455/auth/callback?code=…',
    whole: (pasted) => /[?&]state=/.test(pasted),
    attributes: { 'data-oai-siwc-button': '' },
  },
  claude: {
    button: 'Sign in with Claude',
    icon: <IconLogin size={16} stroke={1.75} aria-hidden="true" />,
    signInAt: 'Sign in to Claude on its page.',
    paste: 'Paste the code it shows you here.',
    field: 'Code',
    placeholder: '',
    whole: (pasted) => pasted.trim().length >= 16,
  },
};

/** A page opened for the sign-in, before its address is known: a browser lets one be opened only on a click. */
function openTab(): Window | null {
  // Null, or nothing at all in some browsers, when no page may be opened.
  const tab = (window.open('', '_blank') as Window | null | undefined) ?? null;
  // The page the sign-in is on is not given this one.
  if (tab !== null) tab.opener = null;
  return tab;
}

/**
 * The button that signs in at a provider, then the step that finishes it, until the account is
 * made. `ready` says whether what it is for is given; `onDone` is called once it is.
 */
export function SignInFlow({
  provider,
  ask,
  ready,
  onActive,
  onDone,
}: {
  provider: SignInProvider;
  /** What the sign-in is for, read when the button is pressed. */
  ask: () => StartSignInRequest;
  ready: boolean;
  /** Whether a sign-in is under way: what it is for may not change meanwhile. */
  onActive?: (active: boolean) => void;
  onDone: (account: Account) => void;
}) {
  const kind = KINDS[provider];
  const calls = engine.signIns[provider];
  const [signIn, setSignIn] = useState<SignIn | null>(null);
  const [answer, setAnswer] = useState('');
  const tab = useRef<Window | null>(null);
  const start = useMutation({
    mutationFn: () => calls.start(ask()),
    onSuccess: (started) => {
      setSignIn(started);
      setAnswer('');
      if (tab.current !== null && !tab.current.closed) tab.current.location.href = started.url;
      tab.current = null;
    },
    onError: () => {
      tab.current?.close();
      tab.current = null;
    },
  });
  const finish = useMutation({
    mutationFn: (given: string) => calls.finish(signIn?.id ?? '', given.trim()),
    onSuccess: (account) => {
      setSignIn(null);
      void queryClient.invalidateQueries({ queryKey: keys.all });
      onDone(account);
    },
    onError: async (error) => {
      // It expired, or was given up: another is started from the button.
      if ((error as { code?: string }).code === 'not_found') {
        setSignIn(null);
        return;
      }
      // The provider may have refused it in a way that starts it again, on a new page.
      if (signIn === null) return;
      const now = await calls.get(signIn.id).catch(() => undefined);
      if (now !== undefined && now.url !== signIn.url) {
        setSignIn(now);
        setAnswer('');
      }
    },
  });
  const send = (given: string = answer): void => {
    if (given.trim() !== '' && !finish.isPending) finish.mutate(given);
  };

  const active = signIn !== null || start.isPending;
  useEffect(() => onActive?.(active), [active, onActive]);

  // A sign-in left waiting is given up: what it ends with finishes nothing later.
  const waiting = useRef<string | null>(null);
  waiting.current = signIn?.id ?? null;
  useEffect(
    () => () => {
      if (waiting.current !== null) void calls.cancel(waiting.current).catch(() => undefined);
    },
    [calls],
  );

  if (signIn === null) {
    return (
      <div className="sign-in-flow">
        <Button
          variant="primary"
          className="sign-in-flow__button"
          {...kind.attributes}
          busy={start.isPending}
          disabled={!ready}
          onClick={() => {
            tab.current = openTab();
            start.mutate();
          }}
        >
          {kind.icon}
          {kind.button}
        </Button>
        <FormError error={start.error ?? finish.error} />
      </div>
    );
  }
  return (
    <div className="sign-in-flow">
      <ol className="sign-in-steps">
        <li>
          <span className="sign-in-steps__text">{kind.signInAt}</span>
          <a
            className={buttonClass('secondary', 'sm')}
            href={signIn.url}
            target="_blank"
            rel="noreferrer noopener"
          >
            Open {new URL(signIn.url).host}
            <IconExternalLink size={13} stroke={1.75} aria-hidden="true" />
          </a>
        </li>
        <li>
          <span className="sign-in-steps__text">{kind.paste}</span>
          {/* Not a form: the flow is inside the dialog's own, and a form holds no form. */}
          <div className="sign-in-answer">
            <Field label={kind.field}>
              {(field) => (
                <input
                  id={field}
                  className="ac-input"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={kind.placeholder}
                  disabled={finish.isPending}
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  // What the page ends with lasts only a little while: it is sent as soon as it is pasted.
                  onPaste={(e) => {
                    const pasted = e.clipboardData.getData('text');
                    if (!kind.whole(pasted)) return;
                    e.preventDefault();
                    setAnswer(pasted);
                    send(pasted);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    // The dialog's own form is not sent: what was pasted is.
                    e.preventDefault();
                    send();
                  }}
                />
              )}
            </Field>
            <Button
              variant="primary"
              busy={finish.isPending}
              disabled={answer.trim() === ''}
              onClick={() => send()}
            >
              Sign in
            </Button>
          </div>
        </li>
      </ol>
      <FormError error={finish.error} />
    </div>
  );
}

/** Signs an account in again, after its sign-in ended, or when it is about to. */
export function SignInAgainDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const provider: SignInProvider = account.provider === 'claude' ? 'claude' : 'chatgpt';
  return (
    <Dialog
      title={`Sign ${account.name} in again`}
      onClose={onClose}
      footer={
        <Button variant="quiet" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      <div className="dialog-form">
        {account.signIn?.signedOut !== undefined && (
          <p className="note note--warn">{displayText(account.signIn.signedOut)}</p>
        )}
        <SignInFlow
          provider={provider}
          ask={() => ({ account: account.id })}
          ready
          onDone={onClose}
        />
      </div>
    </Dialog>
  );
}
