// The pages of signing in, from a person's side: what they are shown, what they send the server,
// and where they go after.

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { api } from '../src/api.ts';
import { INVITE } from '../src/pages/invite.tsx';
import { RESET } from '../src/pages/reset.tsx';
import { SETUP } from '../src/pages/setup.tsx';
import { SIGN_IN } from '../src/pages/sign-in.tsx';
import { open } from './render.tsx';
import { fakeServer } from './server.ts';

const PASSWORD = 'a-password-for-tests';

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label, { exact: false }), { target: { value } });
const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const toast = () => screen.findByRole('alert');
const invalid = (label: string) =>
  screen.getByLabelText(label, { exact: false }).getAttribute('aria-invalid') === 'true';

describe('signing in', () => {
  it('sends the email and password, and goes where the person was going', async () => {
    const server = fakeServer();
    server.person('ada@example.test', PASSWORD);
    const page = open('/sign-in?redirect=%2F', server);
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(screen.getByText(SIGN_IN.forgot)).toBeTruthy();
    type('Email', '  ada@example.test ');
    type('Password', PASSWORD);
    press('Sign in');
    expect(await screen.findByRole('heading', { name: 'Agents' })).toBeTruthy();
    expect(screen.getByText('ada@example.test')).toBeTruthy();
    expect(page.where()).toBe('/agents');
    expect(server.calls.find((call) => call.path === '/v1/sign-in')?.body).toEqual({
      email: 'ada@example.test',
      password: PASSWORD,
      client: 'dashboard',
    });
  });

  it('says so when the email and password do not match, and marks both, until it is dismissed', async () => {
    const server = fakeServer();
    server.person('ada@example.test', PASSWORD);
    open('/sign-in', server);
    await screen.findByRole('heading', { name: 'Sign in' });
    type('Email', 'ada@example.test');
    type('Password', 'not it at all');
    press('Sign in');
    expect((await toast()).textContent).toBe(SIGN_IN.wrong);
    expect(invalid('Email') && invalid('Password')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says how long to wait when it was tried too often, in the server’s words', async () => {
    const server = fakeServer();
    open('/sign-in', server);
    await screen.findByRole('heading', { name: 'Sign in' });
    server.refuseNext(() =>
      server.refused(
        429,
        'rate_limited',
        'Signing in failed too many times: try again in 30 seconds',
      ),
    );
    type('Email', 'ada@example.test');
    type('Password', PASSWORD);
    press('Sign in');
    expect((await toast()).textContent).toBe(
      'Signing in failed too many times: try again in 30 seconds',
    );
    expect(invalid('Email')).toBe(false);
  });

  it('never sends the person to another site, whatever the link to it said', async () => {
    const server = fakeServer();
    server.person('ada@example.test', PASSWORD);
    const page = open('/sign-in?redirect=%2F%2Fevil.example%2Fsteal', server);
    await screen.findByRole('heading', { name: 'Sign in' });
    type('Email', 'ada@example.test');
    type('Password', PASSWORD);
    press('Sign in');
    await screen.findByRole('heading', { name: 'Agents' });
    expect(page.where()).toBe('/agents');
  });

  it('is not shown to someone signed in already: they go where they were going', async () => {
    const server = fakeServer();
    server.person('ada@example.test', PASSWORD, true);
    const page = open('/sign-in?redirect=%2F', server);
    expect(await screen.findByRole('heading', { name: 'Agents' })).toBeTruthy();
    expect(page.where()).toBe('/agents');
  });
});

describe('a page for someone signed in', () => {
  it('sends anyone else to sign in, and back after', async () => {
    const server = fakeServer();
    server.person('ada@example.test', PASSWORD);
    const page = open('/', server);
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(page.where()).toBe('/sign-in?redirect=%2F');
    type('Email', 'ada@example.test');
    type('Password', PASSWORD);
    press('Sign in');
    await screen.findByRole('heading', { name: 'Agents' });
    expect(page.where()).toBe('/agents');
  });

  it('signs out, and is then a page of signing in', async () => {
    const server = fakeServer();
    server.person('ada@example.test', PASSWORD, true);
    const page = open('/', server);
    await screen.findByRole('heading', { name: 'Agents' });
    fireEvent.click(screen.getByRole('button', { name: /ada@example\.test/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(page.where()).toBe('/sign-in');
    expect(server.signedIn).toBeUndefined();
    expect(
      server.calls.some((call) => call.method === 'POST' && call.path === '/v1/sign-out'),
    ).toBe(true);
  });

  it(
    'says so when the server cannot be reached, and opens once it can',
    { timeout: 10_000 },
    async () => {
      const server = fakeServer();
      server.person('ada@example.test', PASSWORD, true);
      let down = true;
      const page = open('/', {
        ...server,
        fetch: (async (input, init) => {
          if (down) throw new TypeError('Failed to fetch');
          return server.fetch(input, init);
        }) as typeof fetch,
      });
      // A call that could not be made is tried twice more, a second and then two apart.
      expect(
        await screen.findByRole(
          'heading',
          { name: 'This page could not be opened' },
          { timeout: 6000 },
        ),
      ).toBeTruthy();
      expect(screen.getByText('The server could not be reached.')).toBeTruthy();
      down = false;
      press('Try again');
      expect(await screen.findByRole('heading', { name: 'Agents' })).toBeTruthy();
      expect(page.where()).toBe('/agents');
    },
  );
});

describe('the setup link', () => {
  it('makes the first account, and signs it in', async () => {
    const server = fakeServer();
    server.link('al_setup', 'setup');
    const page = open('/setup?token=al_setup', server);
    expect(await screen.findByRole('heading', { name: SETUP.title })).toBeTruthy();
    expect(screen.getByText(SETUP.lede)).toBeTruthy();
    type('Name', ' Ada ');
    type('Email', 'ada@example.test');
    type('Password', PASSWORD);
    press('Create account');
    expect(await screen.findByRole('heading', { name: 'Agents' })).toBeTruthy();
    expect(page.where()).toBe('/agents');
    expect(server.calls.find((call) => call.path === '/v1/setup')?.body).toEqual({
      token: 'al_setup',
      email: 'ada@example.test',
      password: PASSWORD,
      displayName: 'Ada',
      client: 'dashboard',
    });
  });

  it('leaves out a name that was not given', async () => {
    const server = fakeServer();
    server.link('al_setup', 'setup');
    open('/setup?token=al_setup', server);
    await screen.findByRole('heading', { name: SETUP.title });
    type('Email', 'ada@example.test');
    type('Password', PASSWORD);
    press('Create account');
    await screen.findByRole('heading', { name: 'Agents' });
    expect(server.calls.find((call) => call.path === '/v1/setup')?.body).not.toHaveProperty(
      'displayName',
    );
  });

  it('says what to do when it was used, and marks no field: it is not of one', async () => {
    open('/setup?token=al_used');
    await screen.findByRole('heading', { name: SETUP.title });
    type('Email', 'ada@example.test');
    type('Password', PASSWORD);
    press('Create account');
    expect((await toast()).textContent).toBe(SETUP.used);
    expect(invalid('Email') || invalid('Password')).toBe(false);
  });

  it('marks the field the server found wrong', async () => {
    const server = fakeServer();
    server.link('al_setup', 'setup');
    open('/setup?token=al_setup', server);
    await screen.findByRole('heading', { name: SETUP.title });
    // The page asks for ten characters too; the server is the one that decides.
    fireEvent.change(screen.getByLabelText('Password', { exact: false }), {
      target: { value: 'short' },
    });
    type('Email', 'ada@example.test');
    fireEvent.submit(screen.getByRole('button', { name: 'Create account' }));
    // What the server found wrong is said.
    expect((await toast()).textContent).toBe('A password is 10 characters or more');
    expect(invalid('Password')).toBe(true);
    expect(invalid('Email')).toBe(false);
  });

  it('is said to be incomplete without its token', async () => {
    open('/setup');
    expect(await screen.findByRole('heading', { name: 'This link is incomplete' })).toBeTruthy();
    expect(screen.getByText(SETUP.incomplete)).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('an invite', () => {
  it('makes an account, and signs it in', async () => {
    const server = fakeServer();
    server.link('al_invite', 'invite');
    const page = open('/invite?token=al_invite', server);
    expect(await screen.findByRole('heading', { name: INVITE.title })).toBeTruthy();
    type('Email', 'grace@example.test');
    type('Password', PASSWORD);
    press('Create account');
    expect(await screen.findByText('grace@example.test')).toBeTruthy();
    expect(page.where()).toBe('/agents');
  });

  it('says when the email is taken, and marks only the email', async () => {
    const server = fakeServer();
    server.person('ada@example.test', PASSWORD);
    server.link('al_invite', 'invite');
    open('/invite?token=al_invite', server);
    await screen.findByRole('heading', { name: INVITE.title });
    type('Email', 'ada@example.test');
    type('Password', PASSWORD);
    press('Create account');
    expect((await toast()).textContent).toBe(INVITE.taken);
    expect(invalid('Email')).toBe(true);
    expect(invalid('Password')).toBe(false);
    // The invite is not used up by it: another email makes the account.
    type('Email', 'grace@example.test');
    press('Create account');
    expect(await screen.findByText('grace@example.test')).toBeTruthy();
  });

  it('says what to do when it was used', async () => {
    open('/invite?token=al_used');
    await screen.findByRole('heading', { name: INVITE.title });
    type('Email', 'grace@example.test');
    type('Password', PASSWORD);
    press('Create account');
    expect((await toast()).textContent).toBe(INVITE.used);
  });

  it('is said to be incomplete without its token', async () => {
    open('/invite?token=');
    expect(await screen.findByText(INVITE.incomplete)).toBeTruthy();
  });
});

describe('a reset link', () => {
  it('sets a new password, and sends the person to sign in with it', async () => {
    const server = fakeServer();
    server.person('ada@example.test', 'the-old-password', true);
    server.link('al_reset', 'reset', 'ada@example.test');
    const page = open('/reset?token=al_reset', server);
    expect(await screen.findByRole('heading', { name: RESET.title })).toBeTruthy();
    type('New password', PASSWORD);
    press('Set password');
    const done = await screen.findByRole('status');
    expect(within(done).getByRole('heading').textContent).toBe(RESET.done);
    expect(within(done).getByText(RESET.doneLede)).toBeTruthy();
    expect(server.calls.find((call) => call.path === '/v1/password-reset')?.body).toEqual({
      token: 'al_reset',
      password: PASSWORD,
    });
    // Their session ended with it: signing in is next.
    press('Sign in');
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(page.where()).toBe('/sign-in');
    type('Email', 'ada@example.test');
    type('Password', PASSWORD);
    press('Sign in');
    expect(await screen.findByRole('heading', { name: 'Agents' })).toBeTruthy();
  });

  it('says what to do when it was used', async () => {
    open('/reset?token=al_used');
    await screen.findByRole('heading', { name: RESET.title });
    type('New password', PASSWORD);
    press('Set password');
    expect((await toast()).textContent).toBe(RESET.used);
  });

  it('is said to be incomplete without its token', async () => {
    open('/reset');
    expect(await screen.findByText(RESET.incomplete)).toBeTruthy();
  });
});

describe('an address that is no page', () => {
  it('says so, and leads to the start', async () => {
    open('/nowhere/at-all');
    expect(await screen.findByRole('heading', { name: 'There is no such page' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to the start' }).getAttribute('href')).toBe('/');
  });
});

describe('a call the server answers as no one signed in', () => {
  it('sends the person to sign in, and back after, from wherever they were', async () => {
    const server = fakeServer();
    server.person('ada@example.test', PASSWORD, true);
    const page = open('/', server);
    await screen.findByRole('heading', { name: 'Agents' });
    // A call of a page of theirs, after their session ended elsewhere.
    server.refuseNext(() => server.refused(401, 'unauthenticated', 'The session has ended'));
    await api.call('agents.list').catch(() => undefined);
    await waitFor(() => expect(page.where()).toBe('/sign-in?redirect=%2Fagents'));
  });
});
