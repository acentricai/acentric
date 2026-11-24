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

  it('says when the next is taken and where they are, takes one when asked, and lists it', async () => {
    const server = signedIn();
    const page = within(await section(server));
    expect(await page.findByText('Next backup')).toBeTruthy();
    expect(page.getByText('Server')).toBeTruthy();
    expect(page.queryByText('No backup has been taken since the server started')).toBeNull();
    expect(page.getByText('No backups yet')).toBeTruthy();
    fireEvent.click(page.getByRole('button', { name: /Back up now/ }));
    const table = within(page.getByRole('table', { name: 'Backups' }));
    await waitFor(() => expect(table.getAllByRole('row')).toHaveLength(2));
    expect(table.getByText('Manual')).toBeTruthy();
    expect(page.queryByText('The last backup was taken')).toBeNull();
  });

  it('says why the last one failed, and that the bucket is not reached', async () => {
    const server = signedIn();
    server.areas.engine.backups.fail =
      '/data/backups has 3 MB free, and a backup needs about 40 MB';
    const status = server.areas.engine.backups.status;
    if (status === null) throw new Error('backups are on');
    status.bucket = {
      url: 's3://acme-backups/acentric',
      error: 'Listing s3://acme-backups/acentric failed: AccessDenied: Access Denied',
    };
    const page = within(await section(server));
    expect(await page.findByText('The bucket backups are copied to is not reached')).toBeTruthy();
    expect(page.getByText(/AccessDenied: Access Denied/)).toBeTruthy();
    expect(page.getByText('Server and bucket')).toBeTruthy();
    fireEvent.click(page.getByRole('button', { name: 'Back up now' }));
    expect(await page.findByText('The last backup failed')).toBeTruthy();
    expect((await page.findAllByText(/has 3 MB free/)).length).toBeGreaterThan(0);
  });

  it('turns them off, once asked whether to', async () => {
    const server = signedIn();
    const page = within(await section(server));
    fireEvent.click(await page.findByRole('button', { name: /Turn off/ }));
    const asked = within(await screen.findByRole('dialog', { name: 'Turn off backups?' }));
    fireEvent.click(asked.getByRole('button', { name: 'Turn off' }));
    expect(await page.findByText('Backups are not yet enabled')).toBeTruthy();
    expect(page.getByRole('button', { name: /Turn on/ })).toBeTruthy();
    expect(page.queryByRole('button', { name: /Turn off/ })).toBeNull();
    expect(server.areas.engine.backups.set).toMatchObject({ enabled: false });
  });

  it('changes where they are stored, from the settings as they are', async () => {
    const server = signedIn();
    const page = within(await section(server));
    fireEvent.click(await page.findByRole('button', { name: 'Change' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Backup settings' }));
    expect(dialog.getByRole('button', { name: 'How often: Every day' })).toBeTruthy();
    fireEvent.click(dialog.getByRole('radio', { name: 'Server and bucket' }));
    const type = (label: RegExp, value: string) =>
      fireEvent.change(dialog.getByLabelText(label), { target: { value } });
    type(/Bucket URL/, 's3://acme/acentric');
    type(/Access key ID/, 'AKIA');
    type(/Secret access key/, 'shh');
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    expect(await page.findByText('Server and bucket')).toBeTruthy();
    expect(server.areas.engine.backups.set).toMatchObject({
      enabled: true,
      bucket: { url: 's3://acme/acentric', accessKeyId: 'AKIA', secretAccessKey: 'shh' },
    });

    // Again: the secret set before is kept, for the same key.
    fireEvent.click(page.getByRole('button', { name: 'Change' }));
    const again = within(await screen.findByRole('dialog', { name: 'Backup settings' }));
    expect((again.getByLabelText(/Bucket URL/) as HTMLInputElement).value).toBe(
      's3://acme/acentric',
    );
    fireEvent.click(again.getByRole('button', { name: 'Backups kept: 3' }));
    fireEvent.click(again.getByRole('menuitemradio', { name: '5' }));
    fireEvent.click(again.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(server.areas.engine.backups.set).toMatchObject({ keep: 5 }));
    const bucket = (server.areas.engine.backups.set as { bucket: Record<string, unknown> }).bucket;
    expect(bucket).not.toHaveProperty('secretAccessKey');
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
