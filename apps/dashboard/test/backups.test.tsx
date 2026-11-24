// The Backups page, from an admin's side, against a stand-in for the server.

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { everyText, inText, whereText } from '../src/engine/backups.tsx';
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

  it('says the bucket they are copied to, and where each is, and not that they are lost with the disk', async () => {
    const server = signedIn();
    const status = server.areas.engine.backups.status;
    if (status === null) throw new Error('backups are on');
    status.bucket = { url: 's3://acme-backups/acentric', error: null };
    open('/backups', server);
    expect(await screen.findByText('s3://acme-backups/acentric')).toBeTruthy();
    expect(screen.queryByText('The backups are on the disk of what they back up')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Back up now/ }));
    const table = within(screen.getByRole('table', { name: 'Backups' }));
    expect(await table.findByText('Server and bucket')).toBeTruthy();
  });

  it('says the bucket is not reached, and why', async () => {
    const server = signedIn();
    const status = server.areas.engine.backups.status;
    if (status === null) throw new Error('backups are on');
    status.bucket = {
      url: 's3://acme-backups/acentric',
      error: 'Listing s3://acme-backups/acentric failed: AccessDenied: Access Denied',
    };
    open('/backups', server);
    expect(await screen.findByText('The bucket backups are copied to is not reached')).toBeTruthy();
    expect(screen.getByText(/AccessDenied: Access Denied/)).toBeTruthy();
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

describe('where a backup is, in words', () => {
  it('is the server, the bucket, or both', () => {
    const backup = {
      name: 'b.tar',
      kind: 'manual',
      version: '0.15.0',
      createdAt: 0,
      bytes: 1,
    } as const;
    expect(whereText({ ...backup, onServer: true, inBucket: true })).toBe('Server and bucket');
    expect(whereText({ ...backup, onServer: true, inBucket: false })).toBe('Server');
    expect(whereText({ ...backup, onServer: false, inBucket: true })).toBe('Bucket');
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

describe('the Backups section of Settings', () => {
  const section = async (server: ReturnType<typeof signedIn>) => {
    open('/', server);
    await screen.findByRole('heading', { name: 'Agents' });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    const sections = within(dialog).getByRole('navigation', { name: 'Settings' });
    fireEvent.click(within(sections).getByRole('button', { name: 'Backups' }));
    return within(dialog).getAllByRole('region', { name: 'Backups' })[0] as HTMLElement;
  };

  it('says how the last went, takes one when asked, and lists it', async () => {
    const server = signedIn();
    const page = within(await section(server));
    expect(await page.findByText('No backup has been taken since the server started')).toBeTruthy();
    expect(page.getByText('No backups yet')).toBeTruthy();
    fireEvent.click(page.getByRole('button', { name: /Back up now/ }));
    expect(await page.findByText('The last backup was taken')).toBeTruthy();
    const table = within(page.getByRole('table', { name: 'Backups' }));
    await waitFor(() => expect(table.getAllByRole('row')).toHaveLength(2));
    expect(table.getByText('When asked')).toBeTruthy();
  });

  it('says they are off, and turns them on, to the server alone', async () => {
    const server = signedIn();
    server.areas.engine.backups.status = null;
    const page = within(await section(server));
    expect(await page.findByText('Backups are not yet enabled')).toBeTruthy();
    expect(page.queryByRole('button', { name: /Back up now/ })).toBeNull();
    fireEvent.click(page.getByRole('button', { name: /Turn on/ }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Turn on backups' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Backups kept: 3' }));
    fireEvent.click(dialog.getByRole('menuitemradio', { name: '7' }));
    expect(dialog.queryByLabelText(/Bucket URL/)).toBeNull();
    fireEvent.click(dialog.getByRole('button', { name: 'Turn on' }));
    expect(await page.findByRole('button', { name: /Back up now/ })).toBeTruthy();
    expect(page.queryByRole('button', { name: /Turn on/ })).toBeNull();
    expect(server.areas.engine.backups.set).toEqual({
      enabled: true,
      everyMs: 86_400_000,
      keep: 7,
      bucket: null,
    });
  });

  it('turns them on with a bucket, its key given', async () => {
    const server = signedIn();
    server.areas.engine.backups.status = null;
    const page = within(await section(server));
    fireEvent.click(await page.findByRole('button', { name: /Turn on/ }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Turn on backups' }));
    fireEvent.click(dialog.getByRole('radio', { name: 'Server and bucket' }));
    const turnOn = dialog.getByRole('button', { name: 'Turn on' }) as HTMLButtonElement;
    expect(turnOn.disabled).toBe(true);
    const type = (label: RegExp, value: string) =>
      fireEvent.change(dialog.getByLabelText(label), { target: { value } });
    type(/Bucket URL/, 's3://acme/acentric');
    type(/Endpoint/, 'https://r2.example.test');
    type(/Access key ID/, 'AKIA');
    type(/Secret access key/, 'shh');
    expect(turnOn.disabled).toBe(false);
    fireEvent.click(turnOn);
    expect(await page.findByRole('button', { name: /Back up now/ })).toBeTruthy();
    expect(server.areas.engine.backups.set).toEqual({
      enabled: true,
      everyMs: 86_400_000,
      keep: 3,
      bucket: {
        url: 's3://acme/acentric',
        endpoint: 'https://r2.example.test',
        accessKeyId: 'AKIA',
        secretAccessKey: 'shh',
      },
    });
  });

  it('is not there for one who may not manage backups', async () => {
    open('/', signedIn('member'));
    await screen.findByRole('heading', { name: 'Agents' });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    expect(within(dialog).queryByRole('button', { name: 'Backups' })).toBeNull();
  });
});
