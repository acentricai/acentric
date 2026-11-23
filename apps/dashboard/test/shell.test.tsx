// The shell of a person signed in: the sections they may see, where `/` takes them, and a page
// they may not see.

import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { Role } from '@acentric/protocol';
import { ROLE_PERMISSIONS } from '@acentric/protocol';

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
  it('has the sections a person’s role may use: machines for an admin or an owner', () => {
    expect(tabs('owner')).toEqual(['agents', 'machines', 'sandboxes']);
    expect(tabs('admin')).toEqual(['agents', 'machines', 'sandboxes']);
    expect(tabs('member')).toEqual(['agents']);
    expect(tabs('viewer')).toEqual(['agents']);
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
    ).toEqual(['/', '/agents', '/machines', '/sandboxes']);
    expect(within(sidebar).getByText('ada@example.test')).toBeTruthy();
    expect(document.title).toBe('Agents | Acentric');
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
