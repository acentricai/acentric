// Whether there are versions after this server's: which to take next, what GitHub's releases
// say, how often they are asked, and the route that says so.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { readSettings, start } from '../src/index.ts';
import { UpdateCheck, nextOf, releasesOf, versionOf } from '../src/updates.ts';

const released = (
  tag: string,
  at = '2026-11-24T10:00:00Z',
  more: Record<string, unknown> = {},
) => ({
  tag_name: tag,
  draft: false,
  prerelease: true,
  published_at: at,
  html_url: `https://github.com/acentricai/acentric/releases/tag/${tag}`,
  body: `\nNotes of ${tag}.\n`,
  ...more,
});

/** A GitHub that answers with `releases`, counting how often it was asked. */
const github = (releases: unknown[], status = 200) => {
  const asked = { count: 0 };
  const fetcher = (async () => {
    asked.count += 1;
    return new Response(JSON.stringify(releases), { status });
  }) as typeof fetch;
  return { fetcher, asked };
};

describe('which version is taken next', () => {
  it('is a patch, or the newest of the next minor, and never past it', () => {
    expect(versionOf('v0.16.1')).toEqual([0, 16, 1]);
    expect(versionOf('v0.17.0-rc.1')).toBeUndefined();
    expect(nextOf('0.16.0', ['0.16.1'])).toBe('0.16.1');
    expect(nextOf('0.16.1', ['0.17.0', '0.17.2', '0.18.0', '0.16.2'])).toBe('0.17.2');
    expect(nextOf('0.16.1', ['0.18.0'])).toBeNull();
    expect(nextOf('0.16.1', ['0.16.1', '0.15.0'])).toBeNull();
  });
});

describe('the releases GitHub lists', () => {
  it('are those of plain versions, drafts and candidates left out', () => {
    expect(
      releasesOf([
        released('v0.16.1'),
        released('v0.17.0-rc.1'),
        released('v0.17.0', undefined, { draft: true }),
        { tag_name: 'v0.16.0' },
      ]),
    ).toEqual([
      {
        version: '0.16.1',
        publishedAt: Date.parse('2026-11-24T10:00:00Z'),
        url: 'https://github.com/acentricai/acentric/releases/tag/v0.16.1',
        notes: 'Notes of v0.16.1.',
      },
    ]);
    expect(() => releasesOf({ message: 'Not Found' })).toThrow('a list of releases');
  });
});

describe('the update check', () => {
  it('says the versions after this one, newest first, and which to take next', async () => {
    const { fetcher } = github([released('v0.15.0'), released('v0.17.0'), released('v0.16.1')]);
    const check = new UpdateCheck({ version: '0.16.0', enabled: true, fetch: fetcher });
    const said = await check.status();
    expect(said).toMatchObject({
      current: '0.16.0',
      check: 'ok',
      latest: '0.17.0',
      next: '0.17.0',
    });
    expect(said.releases.map((release) => release.version)).toEqual(['0.17.0', '0.16.1']);
  });

  it('asks every few hours, and again when asked, but not more than once a minute', async () => {
    let now = 1_000_000;
    const { fetcher, asked } = github([released('v0.16.1')]);
    const check = new UpdateCheck({
      version: '0.16.0',
      enabled: true,
      fetch: fetcher,
      clock: () => now,
    });
    await check.status();
    await check.status();
    expect(asked.count).toBe(1);
    await check.status(true);
    expect(asked.count).toBe(1);
    now += 61_000;
    await check.status(true);
    expect(asked.count).toBe(2);
    now += 6 * 3_600_000;
    await check.status();
    expect(asked.count).toBe(3);
  });

  it('says why it could not ask, and keeps what it read before', async () => {
    let now = 0;
    const answers = [JSON.stringify([released('v0.16.1')]), 'rate limited'];
    const fetcher = (async () => {
      const body = answers.shift() as string;
      return new Response(body, { status: body === 'rate limited' ? 403 : 200 });
    }) as typeof fetch;
    const check = new UpdateCheck({
      version: '0.16.0',
      enabled: true,
      fetch: fetcher,
      clock: () => now,
    });
    expect((await check.status()).latest).toBe('0.16.1');
    now += 61_000;
    const failed = await check.status(true);
    expect(failed).toMatchObject({ check: 'failed', latest: '0.16.1' });
    expect(failed.error).toContain('GitHub answered 403');
  });

  it('asks nothing when it is off', async () => {
    const { fetcher, asked } = github([released('v0.16.1')]);
    const check = new UpdateCheck({ version: '0.16.0', enabled: false, fetch: fetcher });
    expect(await check.status(true)).toMatchObject({ check: 'off', latest: null, releases: [] });
    expect(asked.count).toBe(0);
  });
});

describe('GET /v1/updates', () => {
  const folders: string[] = [];
  afterAll(() => {
    for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true });
  });

  it('says the server’s version, and asks nothing with ACENTRIC_UPDATE_CHECK=off', async () => {
    const data = mkdtempSync(join(tmpdir(), 'acentric-updates-'));
    folders.push(data);
    const admin = 'test-admin-key-of-24-chars-or-more';
    const settings = readSettings({
      ACENTRIC_PORT: '0',
      ACENTRIC_DATA: data,
      ACENTRIC_ADMIN_KEY: admin,
      ACENTRIC_CODE_PROCESSES: '1',
      ACENTRIC_BACKUP_EVERY: 'off',
      ACENTRIC_UPDATE_CHECK: 'off',
    });
    expect(settings.updateCheck).toBe(false);
    expect(() => readSettings({ ACENTRIC_UPDATE_CHECK: 'sometimes' })).toThrow(
      'ACENTRIC_UPDATE_CHECK is on or off',
    );
    const server = await start(settings, { version: '0.16.1', log: () => {} });
    try {
      const answer = await fetch(`${server.server.url}/v1/updates?refresh=true`, {
        headers: { authorization: `Bearer ${admin}` },
      });
      expect(answer.status).toBe(200);
      expect(await answer.json()).toEqual({
        current: '0.16.1',
        check: 'off',
        checkedAt: null,
        error: null,
        latest: null,
        next: null,
        releases: [],
      });
    } finally {
      await server.close();
    }
  }, 60_000);
});
