import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readSettings } from '../src/index.ts';

const KEY = 'ab'.repeat(32);

describe('a server’s settings', () => {
  it('are what a server on one’s own machine wants, when nothing is said', () => {
    const settings = readSettings({});
    expect(settings).toMatchObject({
      port: 4000,
      host: '127.0.0.1',
      adminKey: undefined,
      secretKeys: undefined,
      network: { reach: 'public', allow: [] },
      codeProcesses: 2,
      downloads: undefined,
      dashboard: undefined,
      // It makes sandboxes nowhere until it is told where, and from what.
      docker: undefined,
      boat: {},
    });
    expect(settings.data.endsWith('/data')).toBe(true);
    // It backs itself up every day, into a folder beside its data, keeping three of each kind.
    expect(settings.backups).toEqual({
      dir: `${settings.data}/backups`,
      everyMs: 86_400_000,
      keep: 3,
      bucket: undefined,
    });
  });

  it('say where the server’s backups go and how often, or that there are none', () => {
    expect(
      readSettings({
        ACENTRIC_BACKUP_DIR: '/backups',
        ACENTRIC_BACKUP_EVERY: '6h',
        ACENTRIC_BACKUP_KEEP: '10',
      }).backups,
    ).toEqual({ dir: '/backups', everyMs: 21_600_000, keep: 10, bucket: undefined });
    expect(readSettings({ ACENTRIC_BACKUP_EVERY: '30m' }).backups?.everyMs).toBe(1_800_000);
    expect(readSettings({ ACENTRIC_BACKUP_EVERY: '7d' }).backups?.everyMs).toBe(604_800_000);
    expect(readSettings({ ACENTRIC_BACKUP_EVERY: 'off' }).backups).toBeUndefined();
  });

  it('say the bucket backups are copied to, and where a store that is not S3 is', () => {
    expect(readSettings({ ACENTRIC_BACKUP_URL: 's3://my-bucket' }).backups?.bucket).toEqual({
      url: 's3://my-bucket',
      bucket: 'my-bucket',
      prefix: '',
      endpoint: undefined,
      region: undefined,
    });
    expect(
      readSettings({
        ACENTRIC_BACKUP_URL: 's3://my-bucket/acentric/prod/',
        AWS_ENDPOINT_URL_S3: 'http://minio:9000',
        AWS_REGION: 'eu-west-1',
      }).backups?.bucket,
    ).toEqual({
      url: 's3://my-bucket/acentric/prod',
      bucket: 'my-bucket',
      prefix: 'acentric/prod/',
      endpoint: 'http://minio:9000',
      region: 'eu-west-1',
    });
    for (const url of ['my-bucket', 'https://my-bucket.s3.amazonaws.com', 's3://My_Bucket']) {
      expect(() => readSettings({ ACENTRIC_BACKUP_URL: url })).toThrow(
        /ACENTRIC_BACKUP_URL is a bucket and the folder in it/,
      );
    }
    expect(() =>
      readSettings({ ACENTRIC_BACKUP_URL: 's3://my-bucket', ACENTRIC_BACKUP_EVERY: 'off' }),
    ).toThrow(/ACENTRIC_BACKUP_EVERY=off is for a server that takes none/);
  });

  it('are read from its environment', () => {
    const settings = readSettings({
      ACENTRIC_PORT: '8080',
      ACENTRIC_HOST: '0.0.0.0',
      ACENTRIC_DATA: '/var/lib/acentric',
      ACENTRIC_ADMIN_KEY: 'a-key-an-operator-keeps-somewhere-safe',
      ACENTRIC_AGENT_NETWORK_ALLOW: '10.0.0.0/8, 192.168.1.7',
      ACENTRIC_CODE_PROCESSES: '4',
      // What a provider's models are called with is a model account, and no setting.
      OPENAI_API_KEY: 'sk-test',
    });
    expect(settings).toMatchObject({
      port: 8080,
      host: '0.0.0.0',
      data: '/var/lib/acentric',
      adminKey: 'a-key-an-operator-keeps-somewhere-safe',
      network: { reach: 'public', allow: ['10.0.0.0/8', '192.168.1.7'] },
      codeProcesses: 4,
    });
    expect(JSON.stringify(settings)).not.toContain('sk-test');
    expect(readSettings({ ACENTRIC_AGENT_NETWORK: 'any' }).network).toEqual({ reach: 'any' });
    // Where people reach it, without the slash a person may leave at its end.
    expect(readSettings({ ACENTRIC_PUBLIC_URL: 'https://engine.example.com/' }).publicUrl).toBe(
      'https://engine.example.com',
    );
    expect(readSettings({}).publicUrl).toBeUndefined();
  });

  it('name the key secrets are sealed with by the key itself, and keep the keys from before', () => {
    const one = readSettings({ ACENTRIC_SECRET_KEY: KEY });
    const current = one.secretKeys?.current as string;
    expect(Object.keys(one.secretKeys?.keys ?? {})).toEqual([current]);
    // The same key is the same ID wherever it is given, so what it sealed still opens.
    const older = 'cd'.repeat(32);
    const two = readSettings({ ACENTRIC_SECRET_KEY: older, ACENTRIC_SECRET_KEYS_OLD: KEY });
    expect(two.secretKeys?.current).not.toBe(current);
    expect(Object.keys(two.secretKeys?.keys ?? {})).toContain(current);
  });

  it('say how many actors are in a turn at once', () => {
    expect(readSettings({}).maxTurns).toBe(1000);
    expect(readSettings({ ACENTRIC_MAX_TURNS: '400' }).maxTurns).toBe(400);
    expect(() => readSettings({ ACENTRIC_MAX_TURNS: '0' })).toThrow(
      'ACENTRIC_MAX_TURNS is a whole number from 1 to 10000, and is 0',
    );
  });

  it('keep everything for ever, unless they say how long', () => {
    expect(readSettings({}).retention).toEqual({
      archivedMs: undefined,
      auditMs: undefined,
      usageMs: undefined,
    });
    expect(
      readSettings({
        ACENTRIC_RETAIN_ARCHIVED: '90d',
        ACENTRIC_RETAIN_AUDIT: '365d',
        ACENTRIC_RETAIN_USAGE: '12h',
      }).retention,
    ).toEqual({ archivedMs: 90 * 86_400_000, auditMs: 365 * 86_400_000, usageMs: 12 * 3_600_000 });
    for (const value of ['90', '30m', '0d', 'forever']) {
      expect(() => readSettings({ ACENTRIC_RETAIN_AUDIT: value })).toThrow(
        `ACENTRIC_RETAIN_AUDIT is how long it is kept, such as 90d or 12h, from 1h to 36500d, and is ${value}`,
      );
    }
  });

  it('say how the server logs, and where its metrics are, when they are', () => {
    expect(readSettings({})).toMatchObject({
      log: { format: 'text', level: 'info' },
      metricsPort: undefined,
    });
    expect(
      readSettings({
        ACENTRIC_LOG_FORMAT: 'json',
        ACENTRIC_LOG_LEVEL: 'debug',
        ACENTRIC_METRICS_PORT: '9464',
      }),
    ).toMatchObject({ log: { format: 'json', level: 'debug' }, metricsPort: 9464 });
    expect(() => readSettings({ ACENTRIC_LOG_FORMAT: 'xml' })).toThrow(
      'ACENTRIC_LOG_FORMAT is text or json, and is xml',
    );
    expect(() => readSettings({ ACENTRIC_LOG_LEVEL: 'loud' })).toThrow(
      'ACENTRIC_LOG_LEVEL is debug, info, warn, error, and is loud',
    );
    expect(() => readSettings({ ACENTRIC_PORT: '4000', ACENTRIC_METRICS_PORT: '4000' })).toThrow(
      'ACENTRIC_METRICS_PORT is a port of its own',
    );
  });

  it('take the secret ones from files, as Docker and Kubernetes give secrets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acentric-settings-'));
    const file = (name: string, text: string) => {
      writeFileSync(join(dir, name), text);
      return join(dir, name);
    };
    const old = 'cd'.repeat(32);
    const settings = readSettings({
      ACENTRIC_SECRET_KEY_FILE: file('secret-key', `${KEY}\n`),
      ACENTRIC_SECRET_KEYS_OLD_FILE: file('old-keys', `${old}\n`),
      ACENTRIC_ADMIN_KEY_FILE: file('admin-key', 'an-admin-key-of-24-chars-or-more\r\n'),
    });
    expect(settings.adminKey).toBe('an-admin-key-of-24-chars-or-more');
    expect(settings.secretKeys).toEqual(
      readSettings({ ACENTRIC_SECRET_KEY: KEY, ACENTRIC_SECRET_KEYS_OLD: old }).secretKeys,
    );
    // Not both, and not a file that is not there, or is empty.
    expect(() =>
      readSettings({
        ACENTRIC_ADMIN_KEY: 'x'.repeat(24),
        ACENTRIC_ADMIN_KEY_FILE: join(dir, 'admin-key'),
      }),
    ).toThrow('ACENTRIC_ADMIN_KEY and ACENTRIC_ADMIN_KEY_FILE are both given: give one');
    expect(() => readSettings({ ACENTRIC_SECRET_KEY_FILE: join(dir, 'none') })).toThrow(
      `ACENTRIC_SECRET_KEY_FILE is ${join(dir, 'none')}, which this server cannot read (ENOENT)`,
    );
    expect(() => readSettings({ ACENTRIC_SECRET_KEY_FILE: file('empty', '\n') })).toThrow(
      'which is empty',
    );
    // What is in it is checked as the setting is.
    expect(() => readSettings({ ACENTRIC_SECRET_KEY_FILE: file('short', 'abc') })).toThrow(
      'ACENTRIC_SECRET_KEY is 32 bytes',
    );
  });

  it('say where the dashboard’s build is, from where the server is started', () => {
    expect(readSettings({ ACENTRIC_DASHBOARD: '/srv/dashboard' }).dashboard).toBe('/srv/dashboard');
    expect(readSettings({ ACENTRIC_DASHBOARD: 'apps/dashboard/dist' }).dashboard).toBe(
      `${process.cwd()}/apps/dashboard/dist`,
    );
  });

  it('say which snapshot sandboxes are made from at Boat', () => {
    expect(readSettings({ ACENTRIC_BOAT_TEMPLATE: 'acentric' }).boat).toEqual({
      template: 'acentric',
    });
    expect(
      readSettings({
        ACENTRIC_BOAT_TEMPLATE: 'acentric',
        ACENTRIC_BOAT_API_URL: 'http://127.0.0.1:9999/api/v1',
      }).boat,
    ).toEqual({ template: 'acentric', url: 'http://127.0.0.1:9999/api/v1' });
  });

  it('say where Anthropic’s API is, for tests', () => {
    expect(readSettings({}).anthropicUrl).toBeUndefined();
    expect(readSettings({ ACENTRIC_ANTHROPIC_API_URL: 'http://127.0.0.1:9998' }).anthropicUrl).toBe(
      'http://127.0.0.1:9998',
    );
  });

  it('say where sandboxes are made at Docker, and from which image', () => {
    expect(
      readSettings({
        ACENTRIC_DOCKER_HOST: 'unix:///var/run/docker.sock',
        ACENTRIC_DOCKER_IMAGE: 'acentric-sandbox:1',
      }).docker,
    ).toEqual({ host: 'unix:///var/run/docker.sock', image: 'acentric-sandbox:1' });
    expect(
      readSettings({
        ACENTRIC_DOCKER_HOST: 'tcp://10.0.0.5:2375',
        ACENTRIC_DOCKER_IMAGE: 'acentric-sandbox:1',
        ACENTRIC_DOCKER_NETWORK: 'acentric',
        ACENTRIC_DOCKER_SERVER_URL: 'http://server:4000/',
      }).docker,
    ).toEqual({
      host: 'tcp://10.0.0.5:2375',
      image: 'acentric-sandbox:1',
      network: 'acentric',
      serverUrl: 'http://server:4000',
    });
  });

  it('are refused, with which and why, before anything is started', () => {
    const wrong: [{ [name: string]: string }, RegExp][] = [
      [{ ACENTRIC_PORT: 'eighty' }, /ACENTRIC_PORT is a whole number/],
      [{ ACENTRIC_PORT: '70000' }, /ACENTRIC_PORT/],
      // What Kubernetes gives a pod for the Service acentric: said for what it is.
      [
        { ACENTRIC_PORT: 'tcp://10.43.0.9:80' },
        /Service named acentric.*enableServiceLinks: false/,
      ],
      [{ ACENTRIC_BACKUP_EVERY: '5m' }, /ACENTRIC_BACKUP_EVERY is a time such as 30m/],
      [{ ACENTRIC_BACKUP_EVERY: 'daily' }, /ACENTRIC_BACKUP_EVERY/],
      [{ ACENTRIC_BACKUP_KEEP: '0' }, /ACENTRIC_BACKUP_KEEP is a whole number/],
      [{ ACENTRIC_ADMIN_KEY: 'short' }, /ACENTRIC_ADMIN_KEY is 24 characters or more/],
      [{ ACENTRIC_PUBLIC_URL: 'engine.example.com' }, /ACENTRIC_PUBLIC_URL is where/],
      [{ ACENTRIC_SECRET_KEY: 'not a key' }, /ACENTRIC_SECRET_KEY is 32 bytes/],
      [{ ACENTRIC_SECRET_KEYS_OLD: KEY }, /ACENTRIC_SECRET_KEY is not/],
      [{ ACENTRIC_AGENT_NETWORK: 'private' }, /public or any/],
      [
        { ACENTRIC_AGENT_NETWORK: 'any', ACENTRIC_AGENT_NETWORK_ALLOW: '10.0.0.0/8' },
        /is for ACENTRIC_AGENT_NETWORK=public/,
      ],
      [{ ACENTRIC_CODE_PROCESSES: '0' }, /ACENTRIC_CODE_PROCESSES/],
      [
        { ACENTRIC_DOCKER_HOST: 'unix:///var/run/docker.sock' },
        /ACENTRIC_DOCKER_IMAGE is the image sandboxes are made from/,
      ],
      [
        { ACENTRIC_DOCKER_IMAGE: 'acentric-sandbox' },
        /ACENTRIC_DOCKER_IMAGE is for a server that has ACENTRIC_DOCKER_HOST/,
      ],
      [{ ACENTRIC_DOCKER_NETWORK: 'acentric' }, /is for a server that has ACENTRIC_DOCKER_HOST/],
      [{ ACENTRIC_BOAT_API_URL: 'boat.dev' }, /ACENTRIC_BOAT_API_URL is where Boat's API is/],
      [
        { ACENTRIC_ANTHROPIC_API_URL: 'api.anthropic.com' },
        /ACENTRIC_ANTHROPIC_API_URL is where Anthropic's API is/,
      ],
      [
        { ACENTRIC_DOCKER_HOST: 'ssh://box', ACENTRIC_DOCKER_IMAGE: 'acentric-sandbox' },
        /ACENTRIC_DOCKER_HOST: Docker is reached at unix:\/\/<socket> or http:\/\/<host>:<port>/,
      ],
      [
        {
          ACENTRIC_DOCKER_HOST: 'unix:///var/run/docker.sock',
          ACENTRIC_DOCKER_IMAGE: 'acentric-sandbox',
          ACENTRIC_DOCKER_SERVER_URL: 'server:4000',
        },
        /ACENTRIC_DOCKER_SERVER_URL is where a sandbox reaches the server/,
      ],
    ];
    for (const [env, message] of wrong) {
      expect(() => readSettings(env), JSON.stringify(env)).toThrow(message);
    }
  });
});

describe('SETTINGS.md', () => {
  const source = readFileSync(new URL('../src/settings.ts', import.meta.url), 'utf8');
  const doc = readFileSync(new URL('../../../SETTINGS.md', import.meta.url), 'utf8');
  /** The settings the server reads: each name it is asked for by. */
  const read = new Set(
    [...source.matchAll(/(?:given|secret|list|wholeNumber|keptFor)\('(ACENTRIC_[A-Z_]+)'/g)].map(
      (match) => match[1],
    ),
  );
  /** The settings SETTINGS.md has a row of. */
  const listed = new Set([...doc.matchAll(/^\| `(ACENTRIC_[A-Z_]+)`/gm)].map((match) => match[1]));

  it('has a row for every setting the server reads', () => {
    expect(read.size).toBeGreaterThan(20);
    expect([...read].filter((name) => !listed.has(name))).toEqual([]);
  });

  it('has no row for a setting the server does not read', () => {
    expect([...listed].filter((name) => !read.has(name))).toEqual([]);
  });
});
