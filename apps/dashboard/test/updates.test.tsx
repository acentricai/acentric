// The Updates section of Settings, against a stand-in for the server; and the Markdown its
// release notes are written in.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Markdown, blocksOf } from '../src/markdown.tsx';
import { open } from './render.tsx';
import { fakeServer } from './server.ts';

const signedIn = (role: 'owner' | 'member' = 'owner') => {
  const server = fakeServer();
  server.person('ada@example.test', 'a-password-for-tests', true, role);
  return server;
};
const settings = async (server: ReturnType<typeof signedIn>) => {
  open('/usage', server);
  fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
  return screen.findByRole('dialog', { name: 'Settings' });
};
const section = async (server: ReturnType<typeof signedIn>) => {
  const dialog = await settings(server);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Updates' }));
  return within(within(dialog).getAllByRole('region', { name: 'Updates' })[0] as HTMLElement);
};

describe('the Updates section of Settings', () => {
  it('says the version, that it is up to date, and checks again when asked', async () => {
    const server = signedIn();
    const page = await section(server);
    expect(await page.findByText('0.16.1')).toBeTruthy();
    expect(page.getByText('Up to date')).toBeTruthy();
    fireEvent.click(page.getByRole('button', { name: /Check now/ }));
    await waitFor(() => expect(server.areas.engine.updates.refreshed).toBe(1));
  });

  it('says which version to take next, and what changed in each after this one', async () => {
    const server = signedIn();
    server.areas.engine.updates.status = {
      ...server.areas.engine.updates.status,
      latest: '0.17.0',
      next: '0.17.0',
      releases: [
        {
          version: '0.17.0',
          publishedAt: Date.parse('2026-12-01T10:00:00Z'),
          url: 'https://github.com/acentricai/acentric/releases/tag/v0.17.0',
          notes: '**Upgrading from 0.16.** Take its image.\n\n- A thing\n  that goes on.\n- `code`',
        },
      ],
    };
    const page = await section(server);
    expect(await page.findByText('Version 0.17.0 is available')).toBeTruthy();
    const releases = within(page.getByLabelText('Releases'));
    expect(releases.getByText('Upgrading from 0.16.')).toBeTruthy();
    expect(releases.getByText('A thing that goes on.')).toBeTruthy();
    expect(releases.getByRole('link', { name: '0.17.0 on GitHub' }).getAttribute('href')).toBe(
      'https://github.com/acentricai/acentric/releases/tag/v0.17.0',
    );
  });

  it('says why it could not check, and that checks are off', async () => {
    const server = signedIn();
    server.areas.engine.updates.status = {
      ...server.areas.engine.updates.status,
      check: 'failed',
      error: "GitHub's releases could not be read: GitHub answered 403",
    };
    const page = await section(server);
    expect(await page.findByText('Updates could not be checked')).toBeTruthy();
    expect(page.getByText(/GitHub answered 403/)).toBeTruthy();
  });

  it('is not there for one who does not run the server', async () => {
    const dialog = await settings(signedIn('member'));
    expect(within(dialog).queryByRole('button', { name: 'Updates' })).toBeNull();
  });
});

describe('release notes in Markdown', () => {
  it('joins wrapped lines, keeps lists and code, and makes no link of what is not the web', () => {
    expect(
      blocksOf('One line\nwrapped.\n\n- an item\n  going on\n- another\n\n```\nx = 1\n```'),
    ).toEqual([
      { type: 'paragraph', text: 'One line wrapped.' },
      { type: 'list', ordered: false, items: ['an item going on', 'another'] },
      { type: 'code', text: 'x = 1' },
    ]);
    render(<Markdown text="[docs](https://example.test/a) and [bad](javascript:alert(1))" />);
    expect(screen.getByRole('link', { name: 'docs' }).getAttribute('href')).toBe(
      'https://example.test/a',
    );
    expect(screen.queryByRole('link', { name: 'bad' })).toBeNull();
  });
});
