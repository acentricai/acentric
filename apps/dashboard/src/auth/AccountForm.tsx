// The form a person makes their account with: from the setup link, as the first owner, or from
// an invite. Their name is theirs to give or not; the password is checked by the server too.

import { PASSWORD_MIN } from '@acentric/protocol';
import { useId, useState } from 'react';

import { AuthButton, AuthField } from './controls.tsx';
import { marks } from './failure.ts';

export type Account = {
  readonly email: string;
  readonly password: string;
  readonly displayName?: string;
};

export function AccountForm({
  submit,
  busy,
  error,
  errorId,
  onSubmit,
}: {
  readonly submit: string;
  readonly busy: boolean;
  /** Why the last attempt was refused: the fields it is about are marked, and name the toast. */
  readonly error: unknown;
  readonly errorId: string;
  readonly onSubmit: (account: Account) => void;
}) {
  const id = useId();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  return (
    <form
      className="auth__form rise"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        const displayName = name.trim();
        onSubmit({
          email: email.trim(),
          password,
          ...(displayName === '' ? {} : { displayName }),
        });
      }}
    >
      <AuthField
        id={`${id}-name`}
        label="Name"
        optional
        type="text"
        autoComplete="name"
        maxLength={200}
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        {...marks(error, 'displayName', errorId)}
      />
      <AuthField
        id={`${id}-email`}
        label="Email"
        type="email"
        inputMode="email"
        autoComplete="email"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        {...marks(error, 'email', errorId)}
      />
      <AuthField
        id={`${id}-password`}
        label="Password"
        hint={`${String(PASSWORD_MIN)} characters or more.`}
        type="password"
        autoComplete="new-password"
        required
        minLength={PASSWORD_MIN}
        maxLength={1024}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        {...marks(error, 'password', errorId)}
      />
      <AuthButton type="submit" className="auth__submit" busy={busy} disabled={busy}>
        {submit}
      </AuthButton>
    </form>
  );
}
