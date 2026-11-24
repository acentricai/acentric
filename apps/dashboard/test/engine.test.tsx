// The Engine section's pages, from a person's side, against a stand-in for the server: API keys,
// People and the audit log.

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { HOLDABLE, PERMISSIONS, ROLE_PERMISSIONS } from '@acentric/protocol';
import type { Role } from '@acentric/protocol';

import { detailText } from '../src/engine/audit.tsx';
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
const dialog = () => screen.getByRole('dialog');
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
describe('the API keys page', () => {
  it('opens after the pages that read the agents too, as a fresh tab goes to it', async () => {
    // The Agents, Keys and Machines pages read the same list of agents, kept once: each must
    // read it as the others keep it.
    const server = fakeServer();
    server.person('ada@example.test', 'a-password-for-tests', true, 'owner');
    server.areas.agents.agent('orders', 1);
    const { where } = open('/agents', server);
    expect(await screen.findByRole('link', { name: 'orders' })).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'API keys' }));
    expect(await screen.findByText('No keys')).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Machines' }));
    await waitFor(() => expect(where()).toBe('/machines'));
    expect(await screen.findByRole('heading', { name: 'Machines' })).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Agents' }));
    expect(await screen.findByRole('link', { name: 'orders' })).toBeTruthy();
    expect(screen.queryByText('This page could not be opened')).toBeNull();
  });

  it('makes a key of one agent, shows it once, and lists it by what it reaches', async () => {
    const server = signedIn();
    open('/keys', server);
    expect(await screen.findByText('No keys')).toBeTruthy();
    press('New key');
    fireEvent.change(within(dialog()).getByLabelText('Name'), { target: { value: 'ci' } });
    fireEvent.click(within(dialog()).getByRole('radio', { name: 'One agent' }));
    // What it may do is not asked: it is given all a key of one agent can hold.
    expect(within(dialog()).queryByRole('checkbox')).toBeNull();
    expect(within(dialog()).queryByRole('button', { name: /^Actor: / })).toBeNull();
    fireEvent.click(await within(dialog()).findByRole('button', { name: /^Agent: / }));
    fireEvent.click(await within(dialog()).findByRole('menuitemradio', { name: 'orders' }));
    press('New key', dialog());

    const shown = await screen.findByRole('dialog', { name: 'ci' });
    expect(within(shown).getByText(/^ak_.*_secret-1$/)).toBeTruthy();
    expect(within(shown).getByText(/^export ENGINE_API_KEY=ak_/)).toBeTruthy();
    expect(server.areas.engine.keys[0]).toMatchObject({
      label: 'ci',
      scope: { type: 'agent', agent: ORDERS },
      permissions: [...HOLDABLE.agent],
      expiresAt: null,
    });
    press('Done', shown);
    const row = await waitFor(() => rowOf('ci'));
    expect(within(row).getByText('Agent orders')).toBeTruthy();
    expect(within(row).getByText(`ak_${idOf('key', 1).slice(4)}_…`)).toBeTruthy();
    // The secret is nowhere on the page once its dialog is closed.
    expect(document.body.textContent).not.toContain('secret-1');
  });

  it('chooses a key’s actor among every actor, and gives it all an actor’s key can hold', async () => {
    const server = signedIn();
    open('/keys', server);
    await screen.findByText('No keys');
    press('New key');
    fireEvent.change(within(dialog()).getByLabelText('Name'), { target: { value: 'desk' } });
    fireEvent.click(within(dialog()).getByRole('radio', { name: 'One actor' }));
    expect(within(dialog()).queryByRole('button', { name: /^Agent: / })).toBeNull();
    fireEvent.click(await within(dialog()).findByRole('button', { name: /^Actor: / }));
    fireEvent.click(await within(dialog()).findByRole('menuitemradio', { name: 'eu-desk' }));
    press('New key', dialog());
    await screen.findByRole('dialog', { name: 'desk' });
    expect(server.areas.engine.keys[0]?.permissions).toEqual([...HOLDABLE.actor]);
    press('Done', screen.getByRole('dialog', { name: 'desk' }));
    expect(await screen.findByText('Actor eu-desk')).toBeTruthy();
  });

  it('gives a key all the permissions the person holds, and no others', async () => {
    const server = signedIn('member');
    open('/keys', server);
    await screen.findByText('No keys');
    press('New key');
    fireEvent.change(within(dialog()).getByLabelText('Name'), { target: { value: 'mine' } });
    press('New key', dialog());
    await screen.findByRole('dialog', { name: 'mine' });
    expect(server.areas.engine.keys[0]?.permissions).toEqual(
      PERMISSIONS.filter((permission) => ROLE_PERMISSIONS.member.includes(permission)),
    );
  });

  it('says there is nothing to choose, and opens no empty list', async () => {
    const server = fakeServer();
    server.person('ada@example.test', 'a-password-for-tests', true, 'owner');
    open('/keys', server);
    await screen.findByText('No keys');
    press('New key');
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
    open('/keys', server);
    await screen.findByText('No keys');
    press('New key');
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
    open('/keys', server);
    await screen.findByText('No keys');
    press('New key');
    fireEvent.change(within(dialog()).getByLabelText('Name'), { target: { value: 'old' } });
    press('New key', dialog());
    press('Done', await screen.findByRole('dialog', { name: 'old' }));
    press('Revoke', await waitFor(() => rowOf('old')));
    press('Revoke', await screen.findByRole('dialog', { name: 'Revoke old?' }));
    await waitFor(() => expect(server.areas.engine.keys).toEqual([]));
  });
});

describe('the People page', () => {
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
    open('/people', withPeople());
    const ada = await waitFor(() => rowOf('ada@example.test'));
    expect(within(ada).getByText('you')).toBeTruthy();
    expect(within(ada).getByText('Owner')).toBeTruthy();
    expect(within(rowOf('bea@example.test')).getByText('Member')).toBeTruthy();
    expect(within(rowOf('bea@example.test')).getByText('Active')).toBeTruthy();
    expect(await screen.findByText('No invites waiting.')).toBeTruthy();
  });

  it('makes an invite as a link to pass on, lists it, and revokes it', async () => {
    const server = withPeople();
    open('/people', server);
    await screen.findByText('No invites waiting.');
    press('Invite');
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
    press('Done', made);
    const row = await waitFor(() => rowOf('Admin'));
    expect(within(row).getByText('Admin')).toBeTruthy();
    expect(within(row).getByText('ada@example.test')).toBeTruthy();
    press('Revoke', row);
    press('Revoke', await screen.findByRole('dialog', { name: 'Revoke this invite?' }));
    expect(await screen.findByText('No invites waiting.')).toBeTruthy();
    expect(server.areas.engine.invites).toEqual([]);
  });

  it('changes a role, disables and enables, and makes a password-reset link', async () => {
    const server = withPeople();
    open('/people', server);
    fireEvent.click(item(await menuOf('bea@example.test'), 'Change role'));
    const role = within(await screen.findByRole('dialog')).getByLabelText('Role');
    fireEvent.change(role, { target: { value: 'viewer' } });
    press('Change role', dialog());
    await waitFor(() => expect(within(rowOf('bea@example.test')).getByText('Viewer')).toBeTruthy());

    fireEvent.click(item(await menuOf('bea@example.test'), 'Disable'));
    press('Disable', await screen.findByRole('dialog'));
    await waitFor(() =>
      expect(within(rowOf('bea@example.test')).getByText('Disabled')).toBeTruthy(),
    );
    fireEvent.click(item(await menuOf('bea@example.test'), 'Enable'));
    press('Enable', await screen.findByRole('dialog'));
    await waitFor(() => expect(within(rowOf('bea@example.test')).getByText('Active')).toBeTruthy());

    fireEvent.click(item(await menuOf('bea@example.test'), 'Reset password'));
    press('Make a link', await screen.findByRole('dialog'));
    expect([...server.areas.engine.disabled.keys()]).toEqual([]);
    expect(
      await screen.findByText(new RegExp(`${window.location.origin}/reset\\?token=reset-usr_`)),
    ).toBeTruthy();
  });

  it('does not offer what the server refuses: oneself, and to an admin, admins and owners', async () => {
    open('/people', withPeople('admin'));
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
    press('Invite');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Role: Member' }));
    expect(
      within(dialog())
        .getAllByRole('menuitemradio')
        .map((option) => option.textContent),
    ).toEqual(['Viewer', 'Member']);
  });

  it('says why the server refused, and removes a person', async () => {
    const server = withPeople();
    open('/people', server);
    fireEvent.click(item(await menuOf('cy@example.test'), 'Remove'));
    server.refuseNext(() =>
      server.refused(
        409,
        'conflict',
        'An engine always has an owner who can sign in: this is the last one',
      ),
    );
    press('Remove', await screen.findByRole('dialog'));
    expect(await within(dialog()).findByText(/this is the last one/)).toBeTruthy();
    press('Remove', dialog());
    await waitFor(() => expect(screen.queryByText('cy@example.test')).toBeNull());
  });
});

describe('the Audit log page', () => {
  const withEvents = (count: number) => {
    const server = signedIn();
    const ada = server.areas.engine;
    for (let n = 1; n <= count; n += 1) {
      ada.audit.push(
        eventOf(n, {
          action: n % 2 === 0 ? 'key.create' : 'user.sign_in',
          by: { type: 'user', id: 'usr_1' as never },
          target: n % 2 === 0 ? { type: 'agent', id: ORDERS } : null,
          detail: n % 2 === 0 ? { label: `key ${String(n)}` } : null,
        }),
      );
    }
    return server;
  };
  const whats = () =>
    screen
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getAllByRole('cell')[2]?.textContent);

  it('lists what was done newest first, by whom and to what, by their names', async () => {
    open('/audit', withEvents(2));
    const newest = await waitFor(() => rowOf('Key made'));
    expect(whats()).toEqual(['Key made', 'Signed in']);
    expect(within(newest).getByText('orders')).toBeTruthy();
    expect(within(newest).getByText('label: key 2')).toBeTruthy();
    await waitFor(() => expect(within(newest).getByText('ada@example.test')).toBeTruthy());
  });

  it('is narrowed to one kind of thing done, kept in the address', async () => {
    const page = open('/audit', withEvents(4));
    await waitFor(() => expect(whats()).toHaveLength(4));
    fireEvent.click(screen.getByRole('button', { name: /^Action/ }));
    const list = await screen.findByRole('group', { name: 'Action' });
    fireEvent.click(within(list).getByLabelText('Key made'));
    await waitFor(() => expect(whats()).toEqual(['Key made', 'Key made']));
    expect(page.where()).toBe('/audit?action=key.create');
    // One kind at a time.
    fireEvent.click(within(list).getByLabelText('Signed in'));
    await waitFor(() => expect(whats()).toEqual(['Signed in', 'Signed in']));
    expect(page.where()).toBe('/audit?action=user.sign_in');
    fireEvent.click(screen.getByRole('button', { name: 'Clear Action' }));
    await waitFor(() => expect(whats()).toHaveLength(4));
  });

  it('is read a page at a time', async () => {
    open('/audit', withEvents(60));
    await waitFor(() => expect(whats()).toHaveLength(50));
    expect((screen.getByRole('button', { name: 'Newer' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    press('Older');
    await waitFor(() => expect(whats()).toHaveLength(10));
    press('Newer');
    await waitFor(() => expect(whats()).toHaveLength(50));
  });

  it('writes what else was said as name and value', () => {
    expect(detailText({ role: 'admin', disabled: true })).toBe('role: admin, disabled: true');
    expect(detailText(null)).toBe('');
  });
});
