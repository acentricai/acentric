// Signing in with ChatGPT, as OpenAI's Sign in with ChatGPT has it for an open-source
// application: the person signs in at OpenAI's page, which then sends their browser to an
// address on their own computer. Nothing is there, so that page does not load; its address is
// pasted here, and the engine finishes the sign-in with it and makes the account. Closing the
// dialog gives the sign-in up.

import { IconBrandOpenai, IconExternalLink } from '@tabler/icons-react';
import type { Account, SignIn, StartSignInRequest } from '@acentric/protocol';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { queryClient } from '../api.ts';
import { displayText } from '../machines/text.tsx';
import { Button, buttonClass, Dialog, Field, FormError } from '../machines/ui.tsx';
import { engine } from './api.ts';
import { keys } from './queries.ts';

/** A page opened for the sign-in, before its address is known: a browser lets one be opened only on a click. */
function openTab(): Window | null {
  // Null, or nothing at all in some browsers, when no page may be opened.
  const tab = (window.open('', '_blank') as Window | null | undefined) ?? null;
  // The page OpenAI's sign-in is on is not given this one.
  if (tab !== null) tab.opener = null;
  return tab;
}

/**
 * The button that signs in with ChatGPT, then the step that finishes it, until the account is
 * made. `ready` says whether what it is for is given; `onDone` is called once it is.
 */
export function ChatGptSignInFlow({
  ask,
  ready,
  onActive,
  onDone,
}: {
  /** What the sign-in is for, read when the button is pressed. */
  ask: () => StartSignInRequest;
  ready: boolean;
  /** Whether a sign-in is under way: what it is for may not change meanwhile. */
  onActive?: (active: boolean) => void;
  onDone: (account: Account) => void;
}) {
  const [signIn, setSignIn] = useState<SignIn | null>(null);
  const [address, setAddress] = useState('');
  const tab = useRef<Window | null>(null);
  const start = useMutation({
    mutationFn: () => engine.startChatGptSignIn(ask()),
    onSuccess: (started) => {
      setSignIn(started);
      setAddress('');
      if (tab.current !== null && !tab.current.closed) tab.current.location.href = started.url;
      tab.current = null;
    },
    onError: () => {
      tab.current?.close();
      tab.current = null;
    },
  });
  const finish = useMutation({
    mutationFn: (given: string) => engine.finishChatGptSignIn(signIn?.id ?? '', given.trim()),
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
      // ChatGPT may have refused it in a way that starts it again, on a new page.
      if (signIn === null) return;
      const now = await engine.chatGptSignIn(signIn.id).catch(() => undefined);
      if (now !== undefined && now.url !== signIn.url) {
        setSignIn(now);
        setAddress('');
      }
    },
  });
  const send = (given: string = address): void => {
    if (given.trim() !== '' && !finish.isPending) finish.mutate(given);
  };

  const active = signIn !== null || start.isPending;
  useEffect(() => onActive?.(active), [active, onActive]);

  // A sign-in left waiting is given up: its address finishes nothing later.
  const waiting = useRef<string | null>(null);
  waiting.current = signIn?.id ?? null;
  useEffect(
    () => () => {
      if (waiting.current !== null) {
        void engine.cancelChatGptSignIn(waiting.current).catch(() => undefined);
      }
    },
    [],
  );

  if (signIn === null) {
    return (
      <div className="chatgpt-sign-in">
        <Button
          variant="primary"
          className="chatgpt-sign-in__button"
          data-oai-siwc-button=""
          busy={start.isPending}
          disabled={!ready}
          onClick={() => {
            tab.current = openTab();
            start.mutate();
          }}
        >
          <IconBrandOpenai size={16} stroke={1.75} aria-hidden="true" />
          Sign in with ChatGPT
        </Button>
        <FormError error={start.error ?? finish.error} />
      </div>
    );
  }
  return (
    <div className="chatgpt-sign-in">
      <ol className="chatgpt-steps">
        <li>
          <span className="chatgpt-steps__text">Sign in to ChatGPT on OpenAI’s page.</span>
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
          <span className="chatgpt-steps__text">
            The page it sends you to does not load. Paste its address here.
          </span>
          {/* Not a form: the flow is inside the dialog's own, and a form holds no form. */}
          <div className="chatgpt-address">
            <Field label="Address">
              {(field) => (
                <input
                  id={field}
                  className="ac-input"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="http://127.0.0.1:1455/auth/callback?code=…"
                  disabled={finish.isPending}
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  // A code lasts only a little while: an address is sent as soon as it is pasted.
                  onPaste={(e) => {
                    const pasted = e.clipboardData.getData('text');
                    if (!/[?&]state=/.test(pasted)) return;
                    e.preventDefault();
                    setAddress(pasted);
                    send(pasted);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    // The dialog's own form is not sent: the address is.
                    e.preventDefault();
                    send();
                  }}
                />
              )}
            </Field>
            <Button
              variant="primary"
              busy={finish.isPending}
              disabled={address.trim() === ''}
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

/** Signs a ChatGPT account in again, after its sign-in ended, or when it is about to. */
export function SignInAgainDialog({ account, onClose }: { account: Account; onClose: () => void }) {
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
        <ChatGptSignInFlow ask={() => ({ account: account.id })} ready onDone={onClose} />
      </div>
    </Dialog>
  );
}
