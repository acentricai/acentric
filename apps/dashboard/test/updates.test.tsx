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
    expect(await page.findByText('Up to date')).toBeTruthy();
    // The latest is the version it is.
    expect(page.getAllByText('0.16.1')).toHaveLength(2);
    expect(page.queryByText('Last checked')).toBeNull();
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
    expect(await page.findByText('Update available')).toBeTruthy();
    expect(page.queryByText('Version 0.17.0 is available')).toBeNull();
    expect(page.queryByText('Up to date')).toBeNull();
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

  const withNext = (server: ReturnType<typeof signedIn>) => {
    server.areas.engine.updates.status = {
      ...server.areas.engine.updates.status,
      latest: '0.17.0',
      next: '0.17.0',
      updater: { state: 'idle', version: null, at: null, error: null, changedAt: null },
    };
    return server;
  };
  const update = (page: ReturnType<typeof within>) =>
    within(
      page
        .getByText('Update', { selector: '.prefs-row__name' })
        .closest('.prefs-row') as HTMLElement,
    );
  const loaded = (page: ReturnType<typeof within>) =>
    page.findByText('Update', { selector: '.prefs-row__name' });

  it('downloads the next version where an updater runs, then takes it once asked whether to', async () => {
    const server = withNext(signedIn());
    const page = await section(server);
    await loaded(page);
    // First only Download: to take it, it is downloaded first.
    expect(update(page).queryByRole('button', { name: 'Update now' })).toBeNull();
    expect(update(page).queryByRole('button', { name: 'Schedule' })).toBeNull();
    fireEvent.click(update(page).getByRole('button', { name: 'Download' }));
    expect(await page.findByText('0.17.0 downloaded')).toBeTruthy();
    expect(update(page).queryByRole('button', { name: 'Download' })).toBeNull();
    fireEvent.click(update(page).getByRole('button', { name: 'Update now' }));
    const asked = within(await screen.findByRole('dialog', { name: 'Update to 0.17.0 now?' }));
    fireEvent.click(asked.getByRole('button', { name: 'Update now' }));
    expect(await page.findByText('Updating to 0.17.0…')).toBeTruthy();
  });

  it('says it is downloading while the updater has not answered', async () => {
    const server = withNext(signedIn());
    server.areas.engine.updates.silent = true;
    const page = await section(server);
    await loaded(page);
    fireEvent.click(update(page).getByRole('button', { name: 'Download' }));
    expect(await page.findByText('Downloading 0.17.0…')).toBeTruthy();
    expect(update(page).queryByRole('button')).toBeNull();
  });

  it('takes it at a time, and takes that back', async () => {
    const server = withNext(signedIn());
    const page = await section(server);
    await loaded(page);
    fireEvent.click(update(page).getByRole('button', { name: 'Download' }));
    await page.findByText('0.17.0 downloaded');
    fireEvent.click(update(page).getByRole('button', { name: 'Schedule' }));
    const dialog = within(
      await screen.findByRole('dialog', { name: 'Schedule the update to 0.17.0' }),
    );
    fireEvent.change(dialog.getByLabelText('When'), { target: { value: '2099-01-01T03:00' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Schedule' }));
    expect(await page.findByText(/^0\.17\.0 at /)).toBeTruthy();
    expect(server.areas.engine.updates.status.updater?.at).toBe(
      new Date('2099-01-01T03:00').getTime(),
    );
    fireEvent.click(update(page).getByRole('button', { name: 'Cancel' }));
    expect(await update(page).findByRole('button', { name: 'Download' })).toBeTruthy();
  });

  it('offers nothing to take where no updater runs', async () => {
    const server = withNext(signedIn());
    server.areas.engine.updates.status = { ...server.areas.engine.updates.status, updater: null };
    const page = await section(server);
    expect(await page.findByText('Update available')).toBeTruthy();
    expect(page.queryByRole('button', { name: 'Download' })).toBeNull();
  });

  it('says why an update failed', async () => {
    const server = withNext(signedIn());
    server.areas.engine.updates.status = {
      ...server.areas.engine.updates.status,
      updater: {
        state: 'failed',
        version: '0.17.0',
        at: null,
        error: 'it did not become healthy, and 0.16.1 is back',
        changedAt: null,
      },
    };
    const page = await section(server);
    expect(await page.findByText('The update to 0.17.0 failed')).toBeTruthy();
    expect(page.getByText(/0\.16\.1 is back/)).toBeTruthy();
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
