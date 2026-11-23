// `/people`: the people of the engine, with their roles and whether they can sign in, and the
// invites not yet used. An invite and a password reset are links the server makes and the person
// passes on: the engine sends no email.
//
// What the server refuses is not offered: only an owner changes an admin or an owner, or makes
// one, and nobody changes their own role, disables themselves or removes themselves. That the
// last owner who can sign in stays one is the server's to say, in its words.

import { IconPlus } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { isAtLeast, ROLES } from '@acentric/protocol';
import type { Invite, Role, User } from '@acentric/protocol';

import { fullTime } from '../format.ts';
import { useMe, type Me } from '../me.ts';
import {
  Ago,
  Button,
  Confirm,
  CopyButton,
  Dialog,
  Field,
  FormError,
  Label,
  LoadError,
  Menu,
  MenuItem,
  MenuRule,
  PageHeader,
  Status,
  Table,
  errorText,
} from '../ui.tsx';
import { engine, linkTo, queryClient } from './api.ts';

import './keys.css';

export const peopleQueries = {
  people: ['people'] as const,
  invites: ['invites'] as const,
};

const ROLE_NAMES: { readonly [R in Role]: string } = {
  viewer: 'Viewer',
  member: 'Member',
  admin: 'Admin',
  owner: 'Owner',
};

/** What each role may do, in the invite dialog's words. */
const ROLE_TEXT: { readonly [R in Role]: string } = {
  viewer: 'Reads agents, actors and usage',
  member: 'Deploys agents and works with actors, machines and keys',
  admin: 'Also manages machines, model accounts and people, and reads the audit log',
  owner: 'All an admin may, and changes admins and owners',
};

/** The roles `me` may give: only an owner makes an admin or an owner. */
export function rolesFor(me: Me | undefined): readonly Role[] {
  return ROLES.filter((role) => me?.role === 'owner' || !isAtLeast(role, 'admin'));
}

/** Whether `me` may change `person`'s role, or whether they can sign in, or remove them. */
export function mayChange(me: Me | undefined, person: User): boolean {
  return me !== undefined && (me.role === 'owner' || !isAtLeast(person.role, 'admin'));
}

const refresh = () => {
  void queryClient.invalidateQueries({ queryKey: peopleQueries.people });
  void queryClient.invalidateQueries({ queryKey: peopleQueries.invites });
};

/** What was opened from a person's row. */
type Action =
  | { kind: 'role' | 'disable' | 'enable' | 'reset' | 'remove'; person: User }
  | { kind: 'revoke'; invite: Invite };

export function PeoplePage() {
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
  const [action, setAction] = useState<Action | null>(null);
  const close = () => setAction(null);
  const emailOf = (id: string) => people.data?.items.find((one) => one.id === id)?.email;

  return (
    <div className="list-page people-page">
      <PageHeader title="People" spaced>
        <Button variant="primary" onClick={() => setInviting(true)}>
          <IconPlus size={15} stroke={1.75} aria-hidden="true" />
          Invite
        </Button>
      </PageHeader>
      <section className="panel rise" aria-label="People">
        {people.isError && (
          <LoadError things="people" error={people.error} onRetry={() => void people.refetch()} />
        )}
        <Table
          label="People"
          className="members-table"
          loading={people.isPending}
          rows={people.data?.items}
          rowKey={(person) => person.id}
          columns={[
            {
              name: 'Person',
              cell: (person) => (
                <span>
                  <span className="ac-table__name">{person.email}</span>
                  {person.id === me.data?.user && <span className="note"> you</span>}
                  {person.displayName !== null && (
                    <span className="note"> · {person.displayName}</span>
                  )}
                </span>
              ),
            },
            { name: 'Role', cell: (person) => <Label>{ROLE_NAMES[person.role]}</Label> },
            {
              name: 'Status',
              cell: (person) =>
                person.disabledAt === null ? (
                  <Status word="Active" tone="idle" />
                ) : (
                  <Status word="Disabled" tone="closed" />
                ),
            },
            {
              name: 'Joined',
              className: 'ac-table__muted',
              cell: (person) => <Ago at={person.createdAt} />,
            },
            {
              name: 'Actions',
              hidden: true,
              className: 'ac-table__num',
              cell: (person) => <PersonMenu person={person} me={me.data} onAction={setAction} />,
            },
          ]}
        />
      </section>
      <section className="panel rise" aria-label="Invites">
        <div className="panel__head">
          <h2 className="panel__title">Invites</h2>
        </div>
        {invites.isError && (
          <LoadError
            things="invites"
            error={invites.error}
            onRetry={() => void invites.refetch()}
          />
        )}
        <Table
          label="Invites"
          loading={invites.isPending}
          rows={invites.data?.items}
          rowKey={(invite) => invite.id}
          columns={[
            { name: 'Role', cell: (invite) => <Label>{ROLE_NAMES[invite.role]}</Label> },
            {
              name: 'For',
              cell: (invite) => invite.note ?? <span className="ac-table__muted">—</span>,
            },
            {
              name: 'Made by',
              className: 'ac-table__muted',
              cell: (invite) =>
                invite.createdBy.type === 'user'
                  ? (emailOf(invite.createdBy.id) ?? invite.createdBy.id)
                  : invite.createdBy.type === 'key'
                    ? invite.createdBy.id
                    : 'The server',
            },
            {
              name: 'Expires',
              className: 'ac-table__muted',
              cell: (invite) => fullTime(invite.expiresAt),
            },
            {
              name: 'Actions',
              hidden: true,
              className: 'ac-table__num',
              cell: (invite) => (
                <Button
                  variant="quiet"
                  size="sm"
                  className="row-action"
                  onClick={() => setAction({ kind: 'revoke', invite })}
                >
                  Revoke
                </Button>
              ),
            },
          ]}
        />
        {invites.data?.items.length === 0 && <p className="table-empty">No invites waiting.</p>}
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

function PersonMenu({
  person,
  me,
  onAction,
}: {
  person: User;
  me: Me | undefined;
  onAction: (action: Action) => void;
}) {
  const may = mayChange(me, person);
  const self = person.id === me?.user;
  return (
    <Menu label={`Actions for ${person.email}`} variant="more" align="end">
      {(close) => {
        const pick = (kind: 'role' | 'disable' | 'enable' | 'reset' | 'remove') => () => {
          close();
          onAction({ kind, person });
        };
        return (
          <>
            <MenuItem disabled={!may || self} onSelect={pick('role')}>
              Change role
            </MenuItem>
            {person.disabledAt === null ? (
              <MenuItem disabled={!may || self} onSelect={pick('disable')}>
                Disable
              </MenuItem>
            ) : (
              <MenuItem disabled={!may} onSelect={pick('enable')}>
                Enable
              </MenuItem>
            )}
            <MenuItem disabled={!may} onSelect={pick('reset')}>
              Make a password-reset link
            </MenuItem>
            <MenuRule />
            <MenuItem danger disabled={!may || self} onSelect={pick('remove')}>
              Remove
            </MenuItem>
          </>
        );
      }}
    </Menu>
  );
}

/** A link made once, to pass on: it is not shown again. */
function LinkOnce({ link, expiresAt, what }: { link: string; expiresAt: number; what: string }) {
  return (
    <>
      <div className="ac-field">
        <span className="ac-field__label">Link</span>
        <div className="secret-once">
          <code className="secret-once__value">{link}</code>
          <CopyButton value={link} what={what} text />
        </div>
      </div>
      <p className="note">
        It works once, until {fullTime(expiresAt)}, and is not shown again. The engine sends no
        email: pass it on yourself.
      </p>
    </>
  );
}

function InviteDialog({ me, onClose }: { me: Me | undefined; onClose: () => void }) {
  const roles = rolesFor(me);
  const [role, setRole] = useState<Role>('member');
  const [note, setNote] = useState('');
  const formId = useId();
  const invite = useMutation({
    mutationFn: () => engine.invite(role, note.trim() === '' ? undefined : note.trim()),
    onSuccess: refresh,
  });
  if (invite.data !== undefined) {
    return (
      <Dialog
        title="Invite made"
        onClose={onClose}
        wide
        footer={
          <Button variant="primary" onClick={onClose} data-autofocus>
            Done
          </Button>
        }
      >
        <p className="note">
          Whoever opens it makes their own account, as {ROLE_NAMES[invite.data.invite.role]}.
        </p>
        <LinkOnce
          link={linkTo('invite', invite.data.token)}
          expiresAt={invite.data.invite.expiresAt}
          what="invite link"
        />
      </Dialog>
    );
  }
  return (
    <Dialog
      title="Invite someone"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form={formId} variant="primary" busy={invite.isPending}>
            Make a link
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!invite.isPending) invite.mutate();
        }}
      >
        <Field label="Role" hint={ROLE_TEXT[role]}>
          {(id) => (
            <span className="select">
              <select
                id={id}
                className="ac-input"
                value={role}
                onChange={(event) => setRole(event.target.value as Role)}
              >
                {roles.map((each) => (
                  <option key={each} value={each}>
                    {ROLE_NAMES[each]}
                  </option>
                ))}
              </select>
            </span>
          )}
        </Field>
        <Field
          label="For"
          optional
          hint="A note of who it is for. Whoever opens it gives their own email."
        >
          {(id) => (
            <input
              id={id}
              className="ac-input"
              autoComplete="off"
              maxLength={128}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          )}
        </Field>
        <FormError error={invite.error} />
      </form>
    </Dialog>
  );
}

function RoleDialog({
  me,
  person,
  onClose,
}: {
  me: Me | undefined;
  person: User;
  onClose: () => void;
}) {
  const roles = rolesFor(me);
  const [role, setRole] = useState<Role>(person.role);
  const formId = useId();
  const change = useMutation({
    mutationFn: () => engine.changePerson(person.id, { role }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  return (
    <Dialog
      title={`Role of ${person.email}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            busy={change.isPending}
            disabled={role === person.role}
          >
            Change role
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (role !== person.role && !change.isPending) change.mutate();
        }}
      >
        <Field label="Role" hint={ROLE_TEXT[role]}>
          {(id) => (
            <span className="select">
              <select
                id={id}
                className="ac-input"
                value={role}
                onChange={(event) => setRole(event.target.value as Role)}
              >
                {roles.map((each) => (
                  <option key={each} value={each}>
                    {ROLE_NAMES[each]}
                  </option>
                ))}
              </select>
            </span>
          )}
        </Field>
        <FormError error={change.error} />
      </form>
    </Dialog>
  );
}

function SignInConfirm({
  person,
  disable,
  onClose,
}: {
  person: User;
  disable: boolean;
  onClose: () => void;
}) {
  const change = useMutation({
    mutationFn: () => engine.changePerson(person.id, { disabled: disable }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  return (
    <Confirm
      title={`${disable ? 'Disable' : 'Enable'} ${person.email}?`}
      sentence={
        disable
          ? 'They are signed out everywhere, cannot sign in, and their keys stop working until they are enabled again.'
          : 'They can sign in again, and their keys work again.'
      }
      action={disable ? 'Disable' : 'Enable'}
      danger={disable}
      pending={change.isPending}
      error={change.isError ? errorText(change.error) : null}
      onConfirm={() => change.mutate()}
      onClose={onClose}
    />
  );
}

function ResetDialog({ person, onClose }: { person: User; onClose: () => void }) {
  const reset = useMutation({ mutationFn: () => engine.resetLink(person.id) });
  if (reset.data !== undefined) {
    return (
      <Dialog
        title={`Password reset for ${person.email}`}
        onClose={onClose}
        wide
        footer={
          <Button variant="primary" onClick={onClose} data-autofocus>
            Done
          </Button>
        }
      >
        <LinkOnce
          link={linkTo('reset', reset.data.token)}
          expiresAt={reset.data.expiresAt}
          what="reset link"
        />
      </Dialog>
    );
  }
  return (
    <Confirm
      title={`Make a password-reset link for ${person.email}?`}
      sentence="Whoever opens it sets a new password for them. Their password works until then."
      action="Make a link"
      pending={reset.isPending}
      error={reset.isError ? errorText(reset.error) : null}
      onConfirm={() => reset.mutate()}
      onClose={onClose}
    />
  );
}

function RemoveConfirm({ person, onClose }: { person: User; onClose: () => void }) {
  const remove = useMutation({
    mutationFn: () => engine.removePerson(person.id),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  return (
    <Confirm
      title={`Remove ${person.email}?`}
      sentence="They are signed out, and the keys that were theirs are revoked. It cannot be undone."
      action="Remove"
      danger
      pending={remove.isPending}
      error={remove.isError ? errorText(remove.error) : null}
      onConfirm={() => remove.mutate()}
      onClose={onClose}
    />
  );
}

function RevokeConfirm({ invite, onClose }: { invite: Invite; onClose: () => void }) {
  const revoke = useMutation({
    mutationFn: () => engine.revokeInvite(invite.id),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  return (
    <Confirm
      title="Revoke this invite?"
      sentence="Its link no longer works."
      action="Revoke"
      danger
      pending={revoke.isPending}
      error={revoke.isError ? errorText(revoke.error) : null}
      onConfirm={() => revoke.mutate()}
      onClose={onClose}
    />
  );
}
