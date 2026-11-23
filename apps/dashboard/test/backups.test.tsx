// The Backups page, from an admin's side, against a stand-in for the server.

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { everyText, inText } from '../src/engine/backups.tsx';
import { open } from './render.tsx';
import { fakeServer } from './server.ts';

const signedIn = (role: 'owner' | 'member' = 'owner') => {
  const server = fakeServer();
  server.person('ada@example.test', 'a-password-for-tests', true, role);
  return server;
};

describe('the Backups page', () => {
  it('says there is none yet, that they are on the data’s disk, and how often one is taken', async () => {
    open('/backups', signedIn());
    expect(
      await screen.findByText('No backup has been taken since the server started'),
    ).toBeTruthy();
    expect(screen.getByText('The backups are on the disk of what they back up')).toBeTruthy();
    expect(screen.getByText(/One is taken every day/)).toBeTruthy();
    expect(screen.getByText('/data/backups')).toBeTruthy();
    expect(screen.getByText('No backups there yet.')).toBeTruthy();
  });

  it('takes one when asked, and lists it', async () => {
    const server = signedIn();
    open('/backups', server);
    await screen.findByText('No backup has been taken since the server started');
    fireEvent.click(screen.getByRole('button', { name: /Back up now/ }));
    expect(await screen.findByText('The last backup was taken')).toBeTruthy();
    const table = within(screen.getByRole('table', { name: 'Backups' }));
    await waitFor(() => expect(table.getAllByRole('row')).toHaveLength(2));
    expect(table.getByText('When asked')).toBeTruthy();
    expect(table.getByText('5.0 MB')).toBeTruthy();
    expect(server.calls.some((call) => call.method === 'POST' && call.path === '/v1/backups')).toBe(
      true,
    );
  });

  it('says why the last one failed', async () => {
    const server = signedIn();
    server.areas.engine.backups.fail =
      '/data/backups has 3 MB free, and a backup needs about 40 MB';
    open('/backups', server);
    await screen.findByText('No backup has been taken since the server started');
    fireEvent.click(screen.getByRole('button', { name: /Back up now/ }));
    expect(await screen.findByText('The last backup failed')).toBeTruthy();
    expect((await screen.findAllByText(/has 3 MB free/)).length).toBeGreaterThan(0);
  });

  it('says a server with them off takes none, and offers no button', async () => {
    const server = signedIn();
    server.areas.engine.backups.status = null;
    open('/backups', server);
    expect(await screen.findByText('This server takes no backups of its own')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Back up now/ })).toBeNull();
  });

  it('is not there for one who may not manage backups', async () => {
    open('/backups', signedIn('member'));
    expect(await screen.findByText('Nothing here, or you may not see it.')).toBeTruthy();
  });
});

describe('how often, in words', () => {
  it('is in the largest whole unit', () => {
    expect(everyText(86_400_000)).toBe('every day');
    expect(everyText(7 * 86_400_000)).toBe('every 7 days');
    expect(everyText(6 * 3_600_000)).toBe('every 6 hours');
    expect(everyText(30 * 60_000)).toBe('every 30 minutes');
  });
});

describe('when the next is taken, in words', () => {
  it('is ahead of now, in the largest unit that reads well', () => {
    const now = 1_795_305_600_000;
    expect(inText(now + 40_000, now)).toBe('in 40s');
    expect(inText(now + 3 * 60_000, now)).toBe('in 3m');
    expect(inText(now + 23 * 3_600_000, now)).toBe('in 23h');
    expect(inText(now + 3 * 86_400_000, now)).toBe('in 3d');
    expect(inText(now - 5000, now)).toBe('in 0s');
  });
});
