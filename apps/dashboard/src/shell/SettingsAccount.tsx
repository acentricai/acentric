// The Account section of Settings, as rows of a name and what it is, beside each other: the
// person signed in, their name and role, where they are signed in, and their password.

import { PASSWORD_MIN, PHOTO_TYPES, type Session } from '@acentric/protocol';
import { IconPencil, IconPhoto, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { api, keys, queryClient } from '../api.ts';
import { Avatar, CHOSEN_BYTES, sendPhoto, squarePhoto } from '../avatar.tsx';
import { fullTime } from '../format.ts';
import { useMe, type Me } from '../me.ts';
import { sessionName } from '../pages/account.tsx';
import { Button, FormError, LoadError, Menu, MenuItem, Skeleton } from '../ui.tsx';

const ROLES: Record<Me['role'], string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
};

const sessionsKey = ['sessions'] as const;

/** When, to the minute: `Nov 21, 1:44 AM`, with the year when it is not this one. */
function when(at: number): string {
  const day = new Date(at);
  return day.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(day.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** A row: what it is, and a word on it, beside its value or what changes it. */
function Row({
  name,
  note,
  label,
  children,
}: {
  name: string;
  note?: ReactNode;
  /** The ID of the control the name is the label of. */
  label?: string;
  children: ReactNode;
}) {
  return (
    <div className="prefs-row">
      <div className="prefs-row__text">
        {label === undefined ? (
          <span className="prefs-row__name">{name}</span>
        ) : (
          <label className="prefs-row__name" htmlFor={label}>
            {name}
          </label>
        )}
        {note !== undefined && <span className="prefs-row__note">{note}</span>}
      </div>
      <div className="prefs-row__value">{children}</div>
    </div>
  );
}

export function AccountSettings() {
  const me = useMe();
  if (me.isPending) return <Skeleton rows={4} label="Loading the account" />;
  if (me.data === undefined) {
    return <LoadError things="the account" error={me.error} onRetry={() => void me.refetch()} />;
  }
  return (
    <div className="prefs-page">
      <section className="prefs-group" aria-labelledby="prefs-profile">
        <h3 className="prefs-group__title" id="prefs-profile">
          Profile
        </h3>
        <PhotoRow me={me.data} />
        <NameRow me={me.data} />
        <Row name="Email">
          <span className="prefs-row__plain">{me.data.email}</span>
        </Row>
        <Row name="Role">
          <span className="prefs-row__plain">{ROLES[me.data.role]}</span>
        </Row>
      </section>
      <SessionsGroup me={me.data} />
      <PasswordGroup />
    </div>
  );
}

function PhotoRow({ me }: { me: Me }) {
  const chooser = useRef<HTMLInputElement>(null);
  const [tooLarge, setTooLarge] = useState(false);
  const done = () => void queryClient.invalidateQueries({ queryKey: keys.me });
  const give = useMutation({
    mutationFn: async (file: File) => sendPhoto(await squarePhoto(file)),
    onSuccess: done,
  });
  const remove = useMutation({
    mutationFn: () => api.call('me.removePhoto'),
    onSuccess: done,
  });
  const has = me.photo !== null && me.photo !== undefined;
  const busy = give.isPending || remove.isPending;
  return (
    <Row name="Profile picture">
      <input
        ref={chooser}
        type="file"
        accept={PHOTO_TYPES.join(',')}
        className="prefs-photo__file"
        aria-label="Choose a picture"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file === undefined) return;
          remove.reset();
          setTooLarge(file.size > CHOSEN_BYTES);
          if (file.size <= CHOSEN_BYTES) give.mutate(file);
        }}
      />
      {/* The picture is the button: a pencil over it says so, and it opens what changes it. */}
      <Menu
        label="Edit profile picture"
        align="end"
        className="prefs-photo"
        button={
          <span className="prefs-photo__face" data-busy={busy || undefined}>
            <Avatar
              user={me.user}
              photo={me.photo}
              name={me.displayName ?? me.email}
              size={40}
              className="me__avatar"
            />
            <span className="prefs-photo__edit" aria-hidden="true">
              <IconPencil size={16} stroke={1.75} />
            </span>
          </span>
        }
      >
        {(close) => (
          <>
            <MenuItem
              icon={<IconPhoto size={16} stroke={1.75} aria-hidden="true" />}
              onSelect={() => {
                close();
                chooser.current?.click();
              }}
            >
              {has ? 'Replace photo' : 'Upload photo'}
            </MenuItem>
            {has && (
              <MenuItem
                danger
                icon={<IconTrash size={16} stroke={1.75} aria-hidden="true" />}
                onSelect={() => {
                  close();
                  give.reset();
                  remove.mutate();
                }}
              >
                Remove
              </MenuItem>
            )}
          </>
        )}
      </Menu>
      {tooLarge && <p className="prefs-row__note">The picture is larger than 10 MB.</p>}
      <FormError error={give.error ?? remove.error} />
    </Row>
  );
}

function NameRow({ me }: { me: Me }) {
  return (
    <Row name="Name">
      <span className={me.displayName === null ? 'prefs-name__none' : 'prefs-row__plain'}>
        {me.displayName ?? 'None given'}
      </span>
    </Row>
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
    <section className="prefs-group" aria-labelledby="prefs-password">
      <h3 className="prefs-group__title" id="prefs-password">
        Password
      </h3>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          change.mutate();
        }}
      >
        <Row name="Current password" label="prefs-current">
          <input
            id="prefs-current"
            type="password"
            className="ac-input ac-input--md prefs-row__input"
            value={current}
            autoComplete="current-password"
            onChange={(event) => {
              change.reset();
              setCurrent(event.target.value);
            }}
          />
        </Row>
        <Row
          name="New password"
          note={
            short
              ? `A password is ${String(PASSWORD_MIN)} characters or more.`
              : `${String(PASSWORD_MIN)} characters or more. Changing it signs you out everywhere but this browser.`
          }
          label="prefs-new"
        >
          <input
            id="prefs-new"
            type="password"
            className="ac-input ac-input--md prefs-row__input"
            value={password}
            autoComplete="new-password"
            aria-invalid={short || undefined}
            onChange={(event) => {
              change.reset();
              setPassword(event.target.value);
            }}
          />
        </Row>
        <div className="prefs-group__actions">
          <FormError error={change.error} />
          {change.isSuccess && (
            <span className="prefs-row__saved" role="status">
              The password is changed.
            </span>
          )}
          <Button
            type="submit"
            busy={change.isPending}
            disabled={current === '' || password.length < PASSWORD_MIN}
          >
            Change password
          </Button>
        </div>
      </form>
    </section>
  );
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
  const others = (sessions.data?.items ?? []).filter((session) => session.id !== me.session);
  // Every other session, one at a time: the server ends each as it is asked.
  const endOthers = useMutation({
    mutationFn: async (all: readonly Session[]) => {
      for (const session of all) {
        await api.call('sessions.revoke', { params: { session: session.id as never } });
      }
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: sessionsKey }),
  });
  return (
    <section className="prefs-group" aria-labelledby="prefs-sessions">
      <div className="prefs-group__head">
        <h3 className="prefs-group__title" id="prefs-sessions">
          Where you are signed in
        </h3>
        <Button
          size="sm"
          busy={endOthers.isPending}
          disabled={others.length === 0}
          onClick={() => endOthers.mutate(others)}
        >
          Sign out everywhere else
        </Button>
      </div>
      {sessions.isPending ? (
        <Skeleton rows={2} label="Loading the sessions" />
      ) : sessions.isError ? (
        <LoadError
          things="the sessions"
          error={sessions.error}
          onRetry={() => void sessions.refetch()}
        />
      ) : (
        <table className="prefs-table" aria-label="Sessions">
          <thead>
            <tr>
              <th scope="col">Device</th>
              <th scope="col">Signed in</th>
              <th scope="col">Last used</th>
              <th scope="col" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {sessions.data.items.map((session) => {
              const here = session.id === me.session;
              return (
                <tr key={session.id}>
                  <td>
                    <span className="prefs-table__device">
                      <span>{sessionName(session)}</span>
                      {here && <span className="tag">This browser</span>}
                    </span>
                  </td>
                  <td title={fullTime(session.createdAt)}>{when(session.createdAt)}</td>
                  <td
                    title={session.lastUsedAt === null ? undefined : fullTime(session.lastUsedAt)}
                  >
                    {session.lastUsedAt === null ? '—' : when(session.lastUsedAt)}
                  </td>
                  <td className="prefs-table__action">
                    {!here && (
                      <Button
                        size="sm"
                        variant="quiet"
                        busy={end.isPending && end.variables === session.id}
                        onClick={() => end.mutate(session.id)}
                        aria-label={`Sign out ${sessionName(session)}`}
                      >
                        Sign out
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <FormError error={end.error ?? endOthers.error} />
    </section>
  );
}
