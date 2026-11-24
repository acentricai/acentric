// The people of the engine, as the People section of Settings changes them: roles, signing in,
// invites and password resets. An invite and a password reset are links the server makes and
// the person passes on: the engine sends no email.
//
// What the server refuses is not offered: only an owner changes an admin or an owner, or makes
// one, and nobody changes their own role, disables themselves or removes themselves. That the
// last owner who can sign in stays one is the server's to say, in its words.

import { IconKey, IconTrash, IconUserCheck, IconUserCog, IconUserOff } from '@tabler/icons-react';
import type { Icon } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { isAtLeast, ROLES } from '@acentric/protocol';
import type { Invite, Role, User } from '@acentric/protocol';

import { fullTime } from '../format.ts';
import { type Me } from '../me.ts';
import {
  Button,
  Confirm,
  CopyButton,
  Dialog,
  Dropdown,
  Field,
  FormError,
  Menu,
  MenuItem,
  MenuRule,
  errorText,
} from '../ui.tsx';
import { engine, linkTo, queryClient } from './api.ts';

import './keys.css';

export const peopleQueries = {
  people: ['people'] as const,
  invites: ['invites'] as const,
};

export const ROLE_NAMES: { readonly [R in Role]: string } = {
  viewer: 'Viewer',
  member: 'Member',
  admin: 'Admin',
  owner: 'Owner',
};

/** What each role may do, in the role dialog's words. */
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
export type PeopleAction =
  | { kind: 'role' | 'disable' | 'enable' | 'reset' | 'remove'; person: User }
  | { kind: 'revoke'; invite: Invite };

/** An icon of a menu's item, the size the picture's menu has them. */
const icon = (Glyph: Icon) => <Glyph size={16} stroke={1.75} aria-hidden="true" />;

export function PersonMenu({
  person,
  me,
  onAction,
}: {
  person: User;
  me: Me | undefined;
  onAction: (action: PeopleAction) => void;
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
            <MenuItem icon={icon(IconUserCog)} disabled={!may || self} onSelect={pick('role')}>
              Change role
            </MenuItem>
            {person.disabledAt === null ? (
              <MenuItem icon={icon(IconUserOff)} disabled={!may || self} onSelect={pick('disable')}>
                Disable
              </MenuItem>
            ) : (
              <MenuItem icon={icon(IconUserCheck)} disabled={!may} onSelect={pick('enable')}>
                Enable
              </MenuItem>
            )}
            <MenuItem icon={icon(IconKey)} disabled={!may} onSelect={pick('reset')}>
              Reset password
            </MenuItem>
            <MenuRule />
            <MenuItem
              danger
              icon={icon(IconTrash)}
              disabled={!may || self}
              onSelect={pick('remove')}
            >
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

export function InviteDialog({ me, onClose }: { me: Me | undefined; onClose: () => void }) {
  const roles = rolesFor(me);
  const [role, setRole] = useState<Role>('member');
  const formId = useId();
  const invite = useMutation({
    mutationFn: () => engine.invite(role, undefined),
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
      title="Invite member"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form={formId} variant="primary" busy={invite.isPending}>
            Create invite link
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
        <div className="ac-field">
          <span className="ac-field__label">Role</span>
          <Dropdown
            label="Role"
            value={role}
            options={roles.map((each) => ({ value: each, label: ROLE_NAMES[each] }))}
            onChange={setRole}
          />
        </div>
        <FormError error={invite.error} />
      </form>
    </Dialog>
  );
}

export function RoleDialog({
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

export function SignInConfirm({
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

export function ResetDialog({ person, onClose }: { person: User; onClose: () => void }) {
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

export function RemoveConfirm({ person, onClose }: { person: User; onClose: () => void }) {
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
