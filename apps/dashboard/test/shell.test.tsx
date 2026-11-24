// The shell of a person signed in: the sections they may see, where `/` takes them, and a page
// they may not see.

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { Role } from '@acentric/protocol';
import { ROLE_PERMISSIONS } from '@acentric/protocol';

import { queryClient } from '../src/api.ts';
import type { Me } from '../src/me.ts';
import { NOT_FOUND } from '../src/shell/NotFound.tsx';
import { firstTab, tabAt, visibleSections } from '../src/shell/nav.ts';
import { open } from './render.tsx';
import { fakeServer } from './server.ts';

const as = (role: Role): Me => ({
  type: 'user',
  user: 'usr_1' as Me['user'],
  email: 'ada@example.test',
  displayName: null,
  role,
  permissions: [...ROLE_PERMISSIONS[role]],
  session: 'ses_1' as Me['session'],
});
const tabs = (role: Role) =>
  visibleSections(as(role)).flatMap((section) => section.tabs.map((tab) => tab.id));

describe('the sidebar', () => {
  it('has the sections a person’s role may use: machines, accounts and people for an admin or an owner', () => {
    const all = [
      'agents',
      'machines',
      'sandboxes',
      'accounts',
      'usage',
      'keys',
      'people',
      'backups',
      'audit',
    ];
    expect(tabs('owner')).toEqual(all);
    expect(tabs('admin')).toEqual(all);
    expect(tabs('member')).toEqual(['agents', 'usage', 'keys']);
    expect(tabs('viewer')).toEqual(['agents', 'usage']);
    expect(visibleSections(undefined)).toEqual([]);
    expect(firstTab(as('viewer'))?.path).toBe('/agents');
  });

  it('knows which tab a page is on, and one below it', () => {
    expect(tabAt('/sandboxes/prv_1')?.tab.id).toBe('sandboxes');
    expect(tabAt('/machines')?.tab.id).toBe('machines');
    expect(tabAt('/machinesque')).toBeUndefined();
  });

  it('shows them, with who is signed in, beside the page', async () => {
    const server = fakeServer();
    server.person('ada@example.test', 'a-password-for-tests', true);
    const page = open('/', server);
    expect(await screen.findByRole('heading', { name: 'Agents' })).toBeTruthy();
    expect(page.where()).toBe('/agents');
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });
    expect(
      within(sidebar)
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual([
      '/',
      '/agents',
      '/machines',
      '/sandboxes',
      '/llm-providers',
      '/usage',
      '/keys',
      '/people',
      '/backups',
      '/audit',
    ]);
    expect(within(sidebar).getByText('ada@example.test')).toBeTruthy();
    expect(document.title).toBe('Agents | Acentric');
  });

  it('has Settings at its foot, above the account, which opens a dialog of its own', async () => {
    const server = fakeServer();
    server.person('ada@example.test', 'a-password-for-tests', true);
    open('/', server);
    await screen.findByRole('heading', { name: 'Agents' });
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });
    const settings = within(sidebar).getByRole('button', { name: 'Settings' });
    // After every section's tabs, and before the account.
    const account = within(sidebar).getByText('ada@example.test');
    const nav = within(sidebar).getByRole('navigation', { name: 'Main' });
    expect(nav.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      settings.compareDocumentPosition(account) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(settings);
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    const sections = within(dialog).getByRole('navigation', { name: 'Settings' });
    // Its first section is the account: who is signed in, and what changes it.
    expect(
      within(sections).getByRole('button', { name: 'Account' }).getAttribute('aria-current'),
    ).toBe('page');
    const page = within(dialog).getByRole('region', { name: 'Account' });
    expect(await within(page).findByText('ada@example.test')).toBeTruthy();
    expect(within(page).getByRole('table', { name: 'Sessions' })).toBeTruthy();
    // No signing out of all others: each other session is signed out from its own row.
    expect(within(page).queryByRole('button', { name: /everywhere/ })).toBeNull();
    // This browser's too: it signs out here.
    expect(within(page).getByRole('button', { name: 'Sign out this browser' })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
  });
});

describe('the Account section of Settings', () => {
  it('has a picture to give, and one given to change or take away', async () => {
    const server = fakeServer();
    const ada = server.person('ada@example.test', 'a-password-for-tests', true);
    open('/', server);
    await screen.findByRole('heading', { name: 'Agents' });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    let dialog = await screen.findByRole('dialog', { name: 'Settings' });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Edit profile picture' }));
    expect(within(dialog).getByRole('menuitem', { name: 'Upload photo' })).toBeTruthy();
    // A file picker that was cancelled leaves Settings open.
    fireEvent(
      within(dialog).getByLabelText('Choose a picture'),
      new Event('cancel', { bubbles: true }),
    );
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    expect(within(dialog).queryByRole('menuitem', { name: 'Remove' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    cleanup();
    queryClient.clear();

    // With one: it is shown, in Settings and at the foot of the sidebar, by which one it is.
    ada.photo = 'aaaaaaaaaaaaaaaa';
    open('/', server);
    await screen.findByRole('heading', { name: 'Agents' });
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });
    expect(sidebar.querySelector('img.avatar-photo')?.getAttribute('src')).toBe(
      `/v1/users/${ada.id}/photo?v=aaaaaaaaaaaaaaaa`,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    dialog = await screen.findByRole('dialog', { name: 'Settings' });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Edit profile picture' }));
    expect(within(dialog).getByRole('menuitem', { name: 'Replace photo' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('menuitem', { name: 'Remove' }));
    await waitFor(() => expect(ada.photo).toBeNull());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit profile picture' }));
    expect(await within(dialog).findByRole('menuitem', { name: 'Upload photo' })).toBeTruthy();
  });

  it('signs this browser out from its own row, and goes to signing in', async () => {
    const server = fakeServer();
    server.person('ada@example.test', 'a-password-for-tests', true);
    const page = open('/', server);
    await screen.findByRole('heading', { name: 'Agents' });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Sign out this browser' }));
    await waitFor(() => expect(page.where()).toMatch(/^\/sign-in/));
    expect(server.signedIn).toBeUndefined();
  });

  it('shows the name as it is, with nothing to change it', async () => {
    const server = fakeServer();
    server.person('ada@example.test', 'a-password-for-tests', true);
    open('/', server);
    await screen.findByRole('heading', { name: 'Agents' });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    expect(await within(dialog).findByText('None given')).toBeTruthy();
    expect(within(dialog).queryByRole('textbox', { name: 'Name' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Edit name' })).toBeNull();
  });
});

describe('the People section of Settings', () => {
  it('is for one who may manage people: the members, and Invite beside them', async () => {
    const server = fakeServer();
    server.person('ada@example.test', 'a-password-for-tests', true);
    server.person('grace@example.test', 'a-password-for-tests', false, 'member');
    open('/', server);
    await screen.findByRole('heading', { name: 'Agents' });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    const sections = within(dialog).getByRole('navigation', { name: 'Settings' });
    fireEvent.click(within(sections).getByRole('button', { name: 'People' }));
    const page = within(dialog).getByRole('region', { name: 'People' });
    const members = await within(page).findByRole('table', { name: 'Members' });
    expect(within(members).getByText('ada@example.test')).toBeTruthy();
    expect(within(members).getByText('grace@example.test')).toBeTruthy();
    expect(
      within(members).getByRole('button', { name: 'Actions for grace@example.test' }),
    ).toBeTruthy();
    // No list of invites: a link made is passed on, and not tracked here.
    expect(within(page).queryByRole('heading', { name: 'Invites' })).toBeNull();

    // Its dialogs open over Settings, and closing one leaves Settings open.
    fireEvent.click(within(page).getByRole('button', { name: 'Invite' }));
    const invite = await screen.findByRole('dialog', { name: 'Invite member' });
    fireEvent.click(within(invite).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Invite member' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
  });

  it('is not there for one who may not manage people', async () => {
    const server = fakeServer();
    server.person('grace@example.test', 'a-password-for-tests', true, 'member');
    open('/', server);
    await screen.findByRole('heading', { name: 'Agents' });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    const sections = within(dialog).getByRole('navigation', { name: 'Settings' });
    expect(within(sections).getByRole('button', { name: 'Account' })).toBeTruthy();
    expect(within(sections).queryByRole('button', { name: 'People' })).toBeNull();
  });
});

describe('the API keys section of Settings', () => {
  it('lists the keys, makes one and shows it once, and revokes one from its row', async () => {
    const server = fakeServer();
    server.person('ada@example.test', 'a-password-for-tests', true);
    open('/', server);
    await screen.findByRole('heading', { name: 'Agents' });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    const sections = within(dialog).getByRole('navigation', { name: 'Settings' });
    fireEvent.click(within(sections).getByRole('button', { name: 'API keys' }));
    const page = within(dialog).getAllByRole('region', { name: 'API keys' })[0] as HTMLElement;
    await within(page).findByRole('table', { name: 'Keys' });

    fireEvent.click(within(page).getByRole('button', { name: 'New key' }));
    const making = await screen.findByRole('dialog', { name: 'New key' });
    fireEvent.change(within(making).getByLabelText('Name'), { target: { value: 'ci' } });
    fireEvent.click(within(making).getByLabelText(/actors:read/));
    fireEvent.click(within(making).getByRole('button', { name: 'New key' }));
    const shown = await screen.findByRole('dialog', { name: 'ci' });
    fireEvent.click(within(shown).getByRole('button', { name: 'Done' }));
    const keys = await within(page).findByRole('table', { name: 'Keys' });
    expect(await within(keys).findByText('ci')).toBeTruthy();

    fireEvent.click(within(keys).getByRole('button', { name: 'Revoke ci' }));
    const asked = await screen.findByRole('dialog', { name: 'Revoke ci?' });
    fireEvent.click(within(asked).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(within(keys).queryByText('ci')).toBeNull());
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
  });
});

describe('a page a person may not see', () => {
  it('is not there for them, and its tab is not in their sidebar', async () => {
    const server = fakeServer();
    server.person('grace@example.test', 'a-password-for-tests', true, 'member');
    open('/machines', server);
    expect(await screen.findByRole('heading', { name: NOT_FOUND })).toBeTruthy();
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });
    expect(within(sidebar).queryByRole('link', { name: 'Machines' })).toBeNull();
    // Nothing of machines was asked for.
    expect(server.calls.some((call) => call.path === '/v1/machines')).toBe(false);
  });
});
