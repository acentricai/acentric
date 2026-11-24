// The People section of Settings, for one who may manage people: the members of the engine,
// each with what changes them, and the invites not yet used, with one to make. It does what the
// People page does, with its dialogs.

import { IconPlus, IconX } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { Avatar } from '../avatar.tsx';
import { engine } from '../engine/api.ts';
import {
  InviteDialog,
  PersonMenu,
  peopleQueries,
  RemoveConfirm,
  ResetDialog,
  RevokeConfirm,
  RoleDialog,
  ROLE_NAMES,
  SignInConfirm,
} from '../engine/people.tsx';
import type { PeopleAction } from '../engine/people.tsx';
import { date, fullTime } from '../format.ts';
import { useMe } from '../me.ts';
import { Button, LoadError, Skeleton } from '../ui.tsx';

export function PeopleSettings() {
  const me = useMe();
  const people = useQuery({
    queryKey: peopleQueries.people,
    queryFn: ({ signal }) => engine.people(signal),
  });
  const invites = useQuery({
    queryKey: peopleQueries.invites,
    queryFn: ({ signal }) => engine.invites(signal),
  });
  const [inviting, setInviting] = useState(false);
  const [action, setAction] = useState<PeopleAction | null>(null);
  const close = () => setAction(null);
  const emailOf = (id: string) => people.data?.items.find((one) => one.id === id)?.email;

  return (
    <div className="prefs-page">
      <section className="prefs-group" aria-labelledby="prefs-members">
        <h3 className="prefs-group__title" id="prefs-members">
          Members
        </h3>
        {people.isPending ? (
          <Skeleton rows={3} label="Loading the members" />
        ) : people.isError ? (
          <LoadError
            things="the members"
            error={people.error}
            onRetry={() => void people.refetch()}
          />
        ) : (
          <table className="prefs-table" aria-label="Members">
            <thead>
              <tr>
                <th scope="col" aria-label="Member" />
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">Joined</th>
                <th scope="col" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {people.data.items.map((person) => (
                <tr key={person.id}>
                  <td>
                    <span className="prefs-member">
                      <Avatar
                        user={person.id}
                        photo={person.photo}
                        name={person.displayName ?? person.email}
                        size={28}
                        className="me__avatar prefs-member__face"
                      />
                      <span className="prefs-member__text">
                        <span className="prefs-member__name">
                          {person.displayName ?? person.email}
                          {person.id === me.data?.user && <span className="tag">You</span>}
                        </span>
                        {person.displayName !== null && (
                          <span className="prefs-member__email">{person.email}</span>
                        )}
                      </span>
                    </span>
                  </td>
                  <td>{ROLE_NAMES[person.role]}</td>
                  <td>{person.disabledAt === null ? 'Active' : 'Disabled'}</td>
                  <td title={fullTime(person.createdAt)}>{date(person.createdAt)}</td>
                  <td className="prefs-table__action">
                    <PersonMenu person={person} me={me.data} onAction={setAction} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="prefs-group" aria-labelledby="prefs-invites">
        <div className="prefs-group__head">
          <h3 className="prefs-group__title" id="prefs-invites">
            Invites
          </h3>
          <Button size="sm" onClick={() => setInviting(true)}>
            <IconPlus size={15} stroke={1.75} aria-hidden="true" />
            Invite
          </Button>
        </div>
        {invites.isPending ? (
          <Skeleton rows={2} label="Loading the invites" />
        ) : invites.isError ? (
          <LoadError
            things="the invites"
            error={invites.error}
            onRetry={() => void invites.refetch()}
          />
        ) : invites.data.items.length === 0 ? (
          <p className="prefs-empty">No invites waiting.</p>
        ) : (
          <table className="prefs-table" aria-label="Invites">
            <thead>
              <tr>
                <th scope="col">For</th>
                <th scope="col">Role</th>
                <th scope="col">Made by</th>
                <th scope="col">Expires</th>
                <th scope="col" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {invites.data.items.map((invite) => (
                <tr key={invite.id}>
                  <td>{invite.note ?? <span className="prefs-row__note">—</span>}</td>
                  <td>{ROLE_NAMES[invite.role]}</td>
                  <td>
                    {invite.createdBy.type === 'user'
                      ? (emailOf(invite.createdBy.id) ?? invite.createdBy.id)
                      : invite.createdBy.type === 'key'
                        ? invite.createdBy.id
                        : 'The server'}
                  </td>
                  <td title={fullTime(invite.expiresAt)}>{date(invite.expiresAt)}</td>
                  <td className="prefs-table__action">
                    <button
                      type="button"
                      className="prefs-table__out"
                      aria-label="Revoke this invite"
                      title="Revoke"
                      onClick={() => setAction({ kind: 'revoke', invite })}
                    >
                      <IconX size={16} stroke={1.75} aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {inviting && <InviteDialog me={me.data} onClose={() => setInviting(false)} />}
      {action?.kind === 'role' && (
        <RoleDialog me={me.data} person={action.person} onClose={close} />
      )}
      {(action?.kind === 'disable' || action?.kind === 'enable') && (
        <SignInConfirm person={action.person} disable={action.kind === 'disable'} onClose={close} />
      )}
      {action?.kind === 'reset' && <ResetDialog person={action.person} onClose={close} />}
      {action?.kind === 'remove' && <RemoveConfirm person={action.person} onClose={close} />}
      {action?.kind === 'revoke' && <RevokeConfirm invite={action.invite} onClose={close} />}
    </div>
  );
}
