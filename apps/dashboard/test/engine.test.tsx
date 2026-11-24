// The engine's sections of Settings, from a person's side, against a stand-in for the server:
// API keys, People and the audit log.

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { HOLDABLE, PERMISSIONS, ROLE_PERMISSIONS } from '@acentric/protocol';
import type { Role } from '@acentric/protocol';

import { eventOf, idOf } from './fake/engine.ts';
import { open } from './render.tsx';
import { actorOf, fakeServer } from './server.ts';

const ORDERS = idOf('agt', 1);

const signedIn = (role: Role = 'owner') => {
  const server = fakeServer();
  server.person('ada@example.test', 'a-password-for-tests', true, role);
  server.agents.push({ id: ORDERS, name: 'orders' });
  server.actors.push(actorOf(idOf('act', 1), ORDERS, { name: 'eu-desk' }));
  return server;
};
/** The dialog on top: the one Settings opened. */
const dialog = () => screen.getAllByRole('dialog').at(-1) as HTMLElement;
/** Settings at one of its sections, opened from a page every role has. */
const settingsAt = async (server: ReturnType<typeof fakeServer>, name: string) => {
  open('/usage', server);
  fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
  const settings = await screen.findByRole('dialog', { name: 'Settings' });
  const sections = within(settings).getByRole('navigation', { name: 'Settings' });
  fireEvent.click(within(sections).getByRole('button', { name }));
  return within(settings).getAllByRole('region', { name })[0] as HTMLElement;
};
const press = (name: string | RegExp, inside: HTMLElement = document.body) =>
  fireEvent.click(within(inside).getByRole('button', { name }));
/** The row of a table a text is in: the sidebar shows the person's email too. */
const rowOf = (text: string) => {
  const row = screen
    .getAllByText(text)
    .map((each) => each.closest('tr'))
    .find((each) => each !== null);
  if (row === undefined || row === null) throw new Error(`No row has ${text}`);
  return row;
};
describe('the API keys section of Settings', () => {
  it('offers the agents the Agents page read, kept once', async () => {
    // The Agents page and the new key's dialog read the same list of agents, kept once: each
    // must read it as the other keeps it.
    const server = fakeServer();
    server.person('ada@example.test', 'a-password-for-tests', true, 'owner');
    server.areas.agents.agent('orders', 1);
    open('/agents', server);
    expect(await screen.findByRole('link', { name: 'orders' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const settings = await screen.findByRole('dialog', { name: 'Settings' });
    fireEvent.click(within(settings).getByRole('button', { name: 'API keys' }));
    press('New key', within(settings).getAllByRole('region', { name: 'API keys' })[0]);
    fireEvent.click(within(dialog()).getByRole('radio', { name: 'One agent' }));
    fireEvent.click(await within(dialog()).findByRole('button', { name: /^Agent: / }));
    expect(await within(dialog()).findByRole('menuitemradio', { name: 'orders' })).toBeTruthy();
    expect(screen.queryByText('This page could not be opened')).toBeNull();
  });

  it('makes a key of one agent, shows it once, and lists it by what it reaches', async () => {
    const server = signedIn();
    press('New key', await settingsAt(server, 'API keys'));
    fireEvent.change(within(dialog()).getByLabelText('Name'), { target: { value: 'ci' } });
    fireEvent.click(within(dialog()).getByRole('radio', { name: 'One agent' }));
    // What it may do is not asked: it is given all a key of one agent can hold.
    expect(within(dialog()).queryByRole('checkbox')).toBeNull();
    expect(within(dialog()).queryByRole('button', { name: /^Actor: / })).toBeNull();
    fireEvent.click(await within(dialog()).findByRole('button', { name: /^Agent: / }));
    fireEvent.click(await within(dialog()).findByRole('menuitemradio', { name: 'orders' }));
    press('New key', dialog());

    const shown = await screen.findByRole('dialog', { name: 'Save your API key' });
    expect(within(shown).getByText(/^ak_.*_secret-1$/)).toBeTruthy();
    expect(within(shown).queryByText(/ENGINE_API_KEY/)).toBeNull();
    expect(within(shown).getByRole('button', { name: 'Copy key' })).toBeTruthy();
    expect(server.areas.engine.keys[0]).toMatchObject({
      label: 'ci',
      scope: { type: 'agent', agent: ORDERS },
      permissions: [...HOLDABLE.agent],
      expiresAt: null,
    });
    press('Done', shown);
    const row = await waitFor(() => rowOf('ci'));
    expect(within(row).getByText('Agent orders')).toBeTruthy();
    // The secret is nowhere on the page once its dialog is closed.
    expect(document.body.textContent).not.toContain('secret-1');
  });

  it('chooses a key’s actor among every actor, and gives it all an actor’s key can hold', async () => {
    const server = signedIn();
    press('New key', await settingsAt(server, 'API keys'));
    fireEvent.change(within(dialog()).getByLabelText('Name'), { target: { value: 'desk' } });
    fireEvent.click(within(dialog()).getByRole('radio', { name: 'One actor' }));
    expect(within(dialog()).queryByRole('button', { name: /^Agent: / })).toBeNull();
    fireEvent.click(await within(dialog()).findByRole('button', { name: /^Actor: / }));
    fireEvent.click(await within(dialog()).findByRole('menuitemradio', { name: 'eu-desk' }));
    press('New key', dialog());
    await screen.findByRole('dialog', { name: 'Save your API key' });
    expect(server.areas.engine.keys[0]?.permissions).toEqual([...HOLDABLE.actor]);
    press('Done', screen.getByRole('dialog', { name: 'Save your API key' }));
    expect(await screen.findByText('Actor eu-desk')).toBeTruthy();
  });

  it('gives a key all the permissions the person holds, and no others', async () => {
    const server = signedIn('member');
    press('New key', await settingsAt(server, 'API keys'));
    fireEvent.change(within(dialog()).getByLabelText('Name'), { target: { value: 'mine' } });
    press('New key', dialog());
    await screen.findByRole('dialog', { name: 'Save your API key' });
    expect(server.areas.engine.keys[0]?.permissions).toEqual(
      PERMISSIONS.filter((permission) => ROLE_PERMISSIONS.member.includes(permission)),
    );
  });

  it('says there is nothing to choose, and opens no empty list', async () => {
    const server = fakeServer();
    server.person('ada@example.test', 'a-password-for-tests', true, 'owner');
    press('New key', await settingsAt(server, 'API keys'));
    fireEvent.click(within(dialog()).getByRole('radio', { name: 'One agent' }));
    const agent = await within(dialog()).findByRole('button', { name: 'Agent: No agents' });
    expect((agent as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog()).getByRole('radio', { name: 'One actor' }));
    const actor = await within(dialog()).findByRole('button', { name: 'Actor: No actors' });
    expect((actor as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog()).queryByRole('menu')).toBeNull();
  });

  it('says why the server refused a key', async () => {
    const server = signedIn();
    press('New key', await settingsAt(server, 'API keys'));
    fireEvent.change(within(dialog()).getByLabelText('Name'), { target: { value: 'ci' } });
    server.refuseNext(() =>
      server.refused(403, 'forbidden', 'It does not hold audit:read, so it cannot give it'),
    );
    press('New key', dialog());
    expect(
      await within(dialog()).findByText('It does not hold audit:read, so it cannot give it'),
    ).toBeTruthy();
  });

  it('revokes a key', async () => {
    const server = signedIn();
    press('New key', await settingsAt(server, 'API keys'));
    fireEvent.change(within(dialog()).getByLabelText('Name'), { target: { value: 'old' } });
    press('New key', dialog());
    press('Done', await screen.findByRole('dialog', { name: 'Save your API key' }));
    press('Revoke old', await waitFor(() => rowOf('old')));
    press('Revoke', await screen.findByRole('dialog', { name: 'Revoke old?' }));
    await waitFor(() => expect(server.areas.engine.keys).toEqual([]));
  });
});

describe('the People section of Settings', () => {
  const withPeople = (role: Role = 'owner') => {
    const server = signedIn(role);
    server.person('bea@example.test', 'a-password-for-tests', false, 'member');
    server.person('cy@example.test', 'a-password-for-tests', false, 'owner');
    return server;
  };
  const menuOf = async (email: string) => {
    fireEvent.click(await screen.findByRole('button', { name: `Actions for ${email}` }));
    return screen.findByRole('menu');
  };
  const item = (menu: HTMLElement, name: string) =>
    within(menu).getByRole('menuitem', { name }) as HTMLButtonElement;

  it('lists the people, with who is signed in, their roles and whether they can sign in', async () => {
    await settingsAt(withPeople(), 'People');
    const ada = await waitFor(() => rowOf('ada@example.test'));
    expect(within(ada).getByText('You')).toBeTruthy();
    expect(within(ada).getByText('Owner')).toBeTruthy();
    expect(within(rowOf('bea@example.test')).getByText('Member')).toBeTruthy();
    expect(within(rowOf('bea@example.test')).getByText('Active')).toBeTruthy();
  });

  it('makes an invite as a link to pass on', async () => {
    const server = withPeople();
    press('Invite', await settingsAt(server, 'People'));
    // An owner may invite anyone, chosen from the dashboard's own dropdown.
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Role: Member' }));
    expect(
      within(dialog())
        .getAllByRole('menuitemradio')
        .map((option) => option.textContent),
    ).toEqual(['Viewer', 'Member', 'Admin', 'Owner']);
    fireEvent.click(within(dialog()).getByRole('menuitemradio', { name: 'Admin' }));
    expect(within(dialog()).queryByLabelText(/^For/)).toBeNull();
    press('Create invite link', dialog());
    const made = await screen.findByRole('dialog', { name: 'Invite made' });
    expect(within(made).getByText(`${window.location.origin}/invite?token=invite-1`)).toBeTruthy();
    expect(server.areas.engine.invites).toMatchObject([{ role: 'admin' }]);
  });

  it('changes a role, disables and enables, and makes a password-reset link', async () => {
    const server = withPeople();
    await settingsAt(server, 'People');
    fireEvent.click(item(await menuOf('bea@example.test'), 'Change role'));
    await screen.findByRole('dialog', { name: /role/i });
    const role = within(dialog()).getByLabelText('Role');
    fireEvent.change(role, { target: { value: 'viewer' } });
    press('Change role', dialog());
    await waitFor(() => expect(within(rowOf('bea@example.test')).getByText('Viewer')).toBeTruthy());

    fireEvent.click(item(await menuOf('bea@example.test'), 'Disable'));
    await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(2));
    press('Disable', dialog());
    await waitFor(() =>
      expect(within(rowOf('bea@example.test')).getByText('Disabled')).toBeTruthy(),
    );
    fireEvent.click(item(await menuOf('bea@example.test'), 'Enable'));
    await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(2));
    press('Enable', dialog());
    await waitFor(() => expect(within(rowOf('bea@example.test')).getByText('Active')).toBeTruthy());

    fireEvent.click(item(await menuOf('bea@example.test'), 'Reset password'));
    await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(2));
    press('Make a link', dialog());
    expect([...server.areas.engine.disabled.keys()]).toEqual([]);
    expect(
      await screen.findByText(new RegExp(`${window.location.origin}/reset\\?token=reset-usr_`)),
    ).toBeTruthy();
  });

  it('does not offer what the server refuses: oneself, and to an admin, admins and owners', async () => {
    const page = await settingsAt(withPeople('admin'), 'People');
    const mine = await menuOf('ada@example.test');
    expect(item(mine, 'Change role').disabled).toBe(true);
    expect(item(mine, 'Disable').disabled).toBe(true);
    expect(item(mine, 'Remove').disabled).toBe(true);
    fireEvent.keyDown(mine, { key: 'Escape' });
    const owners = await menuOf('cy@example.test');
    expect(item(owners, 'Change role').disabled).toBe(true);
    expect(item(owners, 'Reset password').disabled).toBe(true);
    fireEvent.keyDown(owners, { key: 'Escape' });
    // An admin gives only the roles below admin.
    press('Invite', page);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Role: Member' }));
    expect(
      within(dialog())
        .getAllByRole('menuitemradio')
        .map((option) => option.textContent),
    ).toEqual(['Viewer', 'Member']);
  });

  it('says why the server refused, and removes a person', async () => {
    const server = withPeople();
    await settingsAt(server, 'People');
    fireEvent.click(item(await menuOf('cy@example.test'), 'Remove'));
    server.refuseNext(() =>
      server.refused(
        409,
        'conflict',
        'An engine always has an owner who can sign in: this is the last one',
      ),
    );
    await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(2));
    press('Remove', dialog());
    expect(await within(dialog()).findByText(/this is the last one/)).toBeTruthy();
    press('Remove', dialog());
    await waitFor(() => expect(screen.queryByText('cy@example.test')).toBeNull());
  });
});

describe('the Audit log section of Settings', () => {
  const opened = async (count: number) => {
    const server = signedIn();
    for (let n = 1; n <= count; n += 1) {
      server.areas.engine.audit.push(
        eventOf(n, {
          action: n % 2 === 0 ? 'key.create' : 'user.sign_in',
          by: { type: 'user', id: 'usr_1' as never },
          target: n % 2 === 0 ? { type: 'agent', id: ORDERS } : null,
          detail: n % 2 === 0 ? { label: `key ${String(n)}` } : null,
        }),
      );
    }
    return settingsAt(server, 'Audit log');
  };
  const whats = (page: HTMLElement) =>
    within(within(page).getByRole('table', { name: 'Audit log' }))
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getAllByRole('cell')[2]?.textContent);

  it('lists what was done newest first, and is narrowed to one kind', async () => {
    const page = await opened(4);
    await waitFor(() =>
      expect(whats(page)).toEqual(['Key made', 'Signed in', 'Key made', 'Signed in']),
    );
    expect(within(page).queryByText('label: key 4')).toBeNull();
    // A row opens all the event says.
    fireEvent.click(within(page).getAllByRole('row')[1] as HTMLElement);
    const event = within(await screen.findByRole('dialog', { name: 'Key made' }));
    expect(event.getByText('key.create')).toBeTruthy();
    expect(event.getByText('Label')).toBeTruthy();
    expect(event.getByText('key 4')).toBeTruthy();
    fireEvent.click(event.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Key made' })).toBeNull());
    fireEvent.click(within(page).getByRole('button', { name: 'Action: All actions' }));
    fireEvent.click(within(page).getByRole('menuitemradio', { name: 'Key made' }));
    await waitFor(() => expect(whats(page)).toEqual(['Key made', 'Key made']));
    fireEvent.click(within(page).getByRole('button', { name: 'Action: Key made' }));
    fireEvent.click(within(page).getByRole('menuitemradio', { name: 'Agent deleted' }));
    expect(await within(page).findByText('Nothing of this kind')).toBeTruthy();
  });

  it('is read a page at a time', async () => {
    const page = await opened(60);
    await waitFor(() => expect(whats(page)).toHaveLength(50));
    fireEvent.click(within(page).getByRole('button', { name: 'Older' }));
    await waitFor(() => expect(whats(page)).toHaveLength(10));
  });
});
