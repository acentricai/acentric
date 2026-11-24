// The Account section of Settings, as rows of a name and what it is, beside each other: the
// person signed in, their name and role, and where they are signed in.

import { PHOTO_TYPES } from '@acentric/protocol';
import type { Session } from '@acentric/protocol';
import { IconLogout, IconPencil, IconPhoto, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { api, keys, queryClient } from '../api.ts';
import { Avatar, CHOSEN_BYTES, sendPhoto, squarePhoto } from '../avatar.tsx';
import { fullTime } from '../format.ts';
import { useMe, type Me } from '../me.ts';
import { signOut } from '../sign-out.ts';
import { FormError, LoadError, Menu, MenuItem, Skeleton } from '../ui.tsx';

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

function SessionsGroup({ me }: { me: Me }) {
  const navigate = useNavigate();
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
    <section className="prefs-group" aria-labelledby="prefs-sessions">
      <h3 className="prefs-group__title" id="prefs-sessions">
        Where you are signed in
      </h3>
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
                    <button
                      type="button"
                      className="prefs-table__out"
                      disabled={end.isPending && end.variables === session.id}
                      onClick={() => {
                        // This browser's is signing out: back to signing in.
                        if (here) {
                          void signOut().then(() => navigate({ to: '/sign-in', replace: true }));
                        } else end.mutate(session.id);
                      }}
                      aria-label={
                        here ? 'Sign out this browser' : `Sign out ${sessionName(session)}`
                      }
                      title="Sign out"
                    >
                      <IconLogout size={16} stroke={1.75} aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <FormError error={end.error} />
    </section>
  );
}

/** Where a session signed in from, in words. */
export function sessionName(session: Session): string {
  if (session.label !== null) return session.label;
  return session.client === 'cli' ? 'The command' : 'A browser';
}
