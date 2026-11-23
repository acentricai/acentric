// The account page, from the person's side, against a stand-in for the server.

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { sessionOf } from './fake/account.ts';
import { open } from './render.tsx';
import { fakeServer } from './server.ts';

const signedIn = (role: 'owner' | 'viewer' = 'owner') => {
  const server = fakeServer();
  server.person('ada@example.test', 'a-password-for-tests', true, role);
  return server;
};
const group = (name: string) => screen.getByRole('region', { name });

describe('the account page', () => {
  it('is reached from the user menu, and says who is signed in and what they may do', async () => {
    const page = open('/machines', signedIn());
    fireEvent.click(await screen.findByRole('button', { name: /ada@example\.test/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Account' }));
    await waitFor(() => expect(page.where()).toBe('/account'));
    expect(await screen.findByRole('heading', { name: 'ada@example.test', level: 1 })).toBeTruthy();
    const person = group('Signed in as');
    expect(within(person).getByText('Owner')).toBeTruthy();
    expect(within(person).getByText('users:manage')).toBeTruthy();
  });

  it('changes the name, which then heads the page', async () => {
    const server = signedIn();
    open('/account', server);
    const name = within(await screen.findByRole('region', { name: 'Name' }));
    expect((name.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(name.getByLabelText(/Name/), { target: { value: 'Ada Lovelace' } });
    fireEvent.click(name.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('heading', { name: 'Ada Lovelace', level: 1 })).toBeTruthy();
    expect(server.calls.at(-2)).toMatchObject({
      method: 'PATCH',
      path: '/v1/me',
      body: { displayName: 'Ada Lovelace' },
    });
  });

  it('changes the password, says why a wrong one was refused, and ends the other sessions', async () => {
    const server = signedIn();
    server.areas.account.sessions.push(sessionOf('ses_2', { client: 'cli' }));
    open('/account', server);
    const password = within(await screen.findByRole('region', { name: 'Password' }));
    const change = () => password.getByRole('button', { name: 'Change password' });
    fireEvent.change(password.getByLabelText('Current password'), {
      target: { value: 'not-it-at-all' },
    });
    fireEvent.change(password.getByLabelText('New password'), { target: { value: 'short' } });
    expect(password.getByText('A password is 10 characters or more.')).toBeTruthy();
    expect((change() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(password.getByLabelText('New password'), {
      target: { value: 'a-new-password-1' },
    });
    fireEvent.click(change());
    expect(await password.findByText('The email or the password is wrong')).toBeTruthy();
    // A wrong password signs no one out.
    expect(server.signedIn).toBe('ada@example.test');
    fireEvent.change(password.getByLabelText('Current password'), {
      target: { value: 'a-password-for-tests' },
    });
    fireEvent.click(change());
    expect(await password.findByText('The password is changed.')).toBeTruthy();
    await waitFor(() =>
      expect(within(group('Where you are signed in')).getAllByRole('listitem')).toHaveLength(1),
    );
  });

  it('lists where the person is signed in, and signs out another of them', async () => {
    const server = signedIn();
    server.areas.account.sessions.push(sessionOf('ses_2', { client: 'cli' }));
    open('/account', server);
    const sessions = within(await screen.findByRole('list', { name: 'Sessions' }));
    expect(
      sessions
        .getAllByRole('listitem')
        .map((row) => row.querySelector('.login__label')?.textContent),
    ).toEqual(['Firefox on macOS', 'The command']);
    expect(sessions.getByText('This browser')).toBeTruthy();
    // This browser is signed out below, not here.
    expect(sessions.queryByRole('button', { name: 'Sign out Firefox on macOS' })).toBeNull();
    fireEvent.click(sessions.getByRole('button', { name: 'Sign out The command' }));
    await waitFor(() => expect(sessions.getAllByRole('listitem')).toHaveLength(1));
  });

  it('signs out this browser', async () => {
    const server = signedIn();
    const page = open('/account', server);
    const out = within(await screen.findByRole('region', { name: 'Sign out' }));
    fireEvent.click(out.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(page.where()).toMatch(/^\/sign-in/));
    expect(server.signedIn).toBeUndefined();
  });
});
