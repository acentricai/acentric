// The account: the person signed in, what their role lets them do, their name and password, where
// they are signed in, and the theme. As basic-harness's account page, which showed the key the
// person signed in with: here a person signs in, so it shows the person.

import { IconDeviceDesktop, IconTerminal2 } from '@tabler/icons-react';
import { PASSWORD_MIN, type Session } from '@acentric/protocol';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { api, keys, queryClient } from '../api.ts';
import { useMe, type Me } from '../me.ts';
import { signOut } from '../sign-out.ts';
import { ThemeToggle } from '../theme.tsx';
import { Ago, Button, Field, FormError, LoadError, Skeleton } from '../ui.tsx';

import '../styles/account.css';

const ROLES: Record<Me['role'], string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
};

const sessionsKey = ['sessions'] as const;

export function AccountPage() {
  const me = useMe();
  const navigate = useNavigate();
  const name = me.data === undefined ? undefined : (me.data.displayName ?? me.data.email);
  const initials = (name ?? '')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 2)
    .toUpperCase();
  return (
    <div className="list-page account-page">
      <header className="page__head rise">
        <div className="account-head">
          {name !== undefined && (
            <span className="account-head__avatar">
              <span className="avatar" aria-hidden="true">
                {initials}
              </span>
            </span>
          )}
          <h1 className="page__title">{name ?? 'Account'}</h1>
        </div>
      </header>
      <div className="settings settings--spaced rise">
        <section className="settings__group" aria-labelledby="account-person">
          <div className="settings__intro">
            <h2 className="panel__title" id="account-person">
              Signed in as
            </h2>
          </div>
          <div className="settings__value">
            {me.isPending ? (
              <Skeleton rows={3} label="Loading the account" />
            ) : me.data === undefined ? (
              <LoadError things="the account" error={me.error} onRetry={() => void me.refetch()} />
            ) : (
              <dl className="key-facts">
                <dt>Email</dt>
                <dd>{me.data.email}</dd>
                <dt>Role</dt>
                <dd>{ROLES[me.data.role]}</dd>
                <dt>May</dt>
                <dd>
                  <span className="chips">
                    {me.data.permissions.map((permission) => (
                      <span key={permission} className="chip chip--mono">
                        {permission}
                      </span>
                    ))}
                  </span>
                </dd>
              </dl>
            )}
          </div>
        </section>
        {me.data !== undefined && <NameGroup key={me.data.displayName ?? ''} me={me.data} />}
        <PasswordGroup />
        {me.data !== undefined && <SessionsGroup me={me.data} />}
        <section className="settings__group" aria-labelledby="account-appearance">
          <div className="settings__intro">
            <h2 className="panel__title" id="account-appearance">
              Appearance
            </h2>
          </div>
          <div className="settings__value">
            <ThemeToggle />
          </div>
        </section>
        <section className="settings__group" aria-labelledby="account-sign-out">
          <div className="settings__intro">
            <h2 className="panel__title" id="account-sign-out">
              Sign out
            </h2>
            <p className="note">Ends the session of this browser. Others stay signed in.</p>
          </div>
          <div className="settings__value">
            <Button
              onClick={() => void signOut().then(() => navigate({ to: '/sign-in', replace: true }))}
            >
              Sign out
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}

function NameGroup({ me }: { me: Me }) {
  const [name, setName] = useState(me.displayName ?? '');
  const save = useMutation({
    mutationFn: () => api.call('me.update', { body: { displayName: name.trim() || null } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.me }),
  });
  const unchanged = (name.trim() || null) === me.displayName;
  return (
    <section className="settings__group" aria-labelledby="account-name">
      <div className="settings__intro">
        <h2 className="panel__title" id="account-name">
          Name
        </h2>
        <p className="note">What others see you as. Your email is shown when you give none.</p>
      </div>
      <form
        className="settings__value"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Name" optional>
          {(id) => (
            <input
              id={id}
              className="ac-input ac-input--md"
              value={name}
              maxLength={200}
              autoComplete="name"
              onChange={(event) => {
                save.reset();
                setName(event.target.value);
              }}
            />
          )}
        </Field>
        <FormError error={save.error} />
        <Button type="submit" busy={save.isPending} disabled={unchanged}>
          Save
        </Button>
      </form>
    </section>
  );
}

function PasswordGroup() {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const change = useMutation({
    mutationFn: () => api.call('me.password', { body: { current, password } }),
    onSuccess: () => {
      setCurrent('');
      setPassword('');
      void queryClient.invalidateQueries({ queryKey: sessionsKey });
    },
  });
  const short = password.length > 0 && password.length < PASSWORD_MIN;
  return (
    <section className="settings__group" aria-labelledby="account-password">
      <div className="settings__intro">
        <h2 className="panel__title" id="account-password">
          Password
        </h2>
        <p className="note">Changing it signs you out everywhere but this browser.</p>
      </div>
      <form
        className="settings__value"
        onSubmit={(event) => {
          event.preventDefault();
          change.mutate();
        }}
      >
        <Field label="Current password">
          {(id) => (
            <input
              id={id}
              type="password"
              className="ac-input ac-input--md"
              value={current}
              autoComplete="current-password"
              onChange={(event) => {
                change.reset();
                setCurrent(event.target.value);
              }}
            />
          )}
        </Field>
        <Field
          label="New password"
          hint={`${String(PASSWORD_MIN)} characters or more.`}
          error={short ? `A password is ${String(PASSWORD_MIN)} characters or more.` : undefined}
        >
          {(id) => (
            <input
              id={id}
              type="password"
              className="ac-input ac-input--md"
              value={password}
              autoComplete="new-password"
              onChange={(event) => {
                change.reset();
                setPassword(event.target.value);
              }}
            />
          )}
        </Field>
        <FormError error={change.error} />
        {change.isSuccess && (
          <p className="note" role="status">
            The password is changed.
          </p>
        )}
        <Button
          type="submit"
          busy={change.isPending}
          disabled={current === '' || password.length < PASSWORD_MIN}
        >
          Change password
        </Button>
      </form>
    </section>
  );
}

/** Where a session signed in from, in words. */
export function sessionName(session: Session): string {
  if (session.label !== null) return session.label;
  return session.client === 'cli' ? 'The command' : 'A browser';
}

function SessionsGroup({ me }: { me: Me }) {
  const sessions = useQuery({
    queryKey: sessionsKey,
    queryFn: ({ signal }) => api.call('sessions.list', { query: { limit: 100 }, signal }),
  });
  const end = useMutation({
    mutationFn: (session: string) =>
      api.call('sessions.revoke', { params: { session: session as never } }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: sessionsKey }),
  });
  return (
    <section className="settings__group" aria-labelledby="account-sessions">
      <div className="settings__intro">
        <h2 className="panel__title" id="account-sessions">
          Where you are signed in
        </h2>
        <p className="note">The browsers and commands signed in as you.</p>
      </div>
      <div className="settings__value">
        {sessions.isPending ? (
          <Skeleton rows={2} label="Loading the sessions" />
        ) : sessions.isError ? (
          <LoadError
            things="the sessions"
            error={sessions.error}
            onRetry={() => void sessions.refetch()}
          />
        ) : (
          <ul className="logins" aria-label="Sessions">
            {sessions.data.items.map((session) => {
              const here = session.id === me.session;
              const Icon = session.client === 'cli' ? IconTerminal2 : IconDeviceDesktop;
              return (
                <li key={session.id} className="login">
                  <span className="method__icon" aria-hidden="true">
                    <Icon size={18} stroke={1.75} />
                  </span>
                  <span className="method__text">
                    <span className="method__name">
                      <span className="login__label">{sessionName(session)}</span>
                      {here && <span className="tag">This browser</span>}
                    </span>
                    <span className="note">
                      Signed in <Ago at={session.createdAt} />
                      {session.lastUsedAt !== null && (
                        <>
                          , last used <Ago at={session.lastUsedAt} />
                        </>
                      )}
                    </span>
                  </span>
                  {!here && (
                    <Button
                      size="sm"
                      busy={end.isPending && end.variables === session.id}
                      onClick={() => end.mutate(session.id)}
                      aria-label={`Sign out ${sessionName(session)}`}
                    >
                      Sign out
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <FormError error={end.error} />
      </div>
    </section>
  );
}
