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
      credentials: {},
    });
    expect(settings.data.endsWith('/data')).toBe(true);
  });

  it('are read from its environment', () => {
    const settings = readSettings({
      ACENTRIC_PORT: '8080',
      ACENTRIC_HOST: '0.0.0.0',
      ACENTRIC_DATA: '/var/lib/acentric',
      ACENTRIC_ADMIN_KEY: 'a-key-an-operator-keeps-somewhere-safe',
      ACENTRIC_AGENT_NETWORK_ALLOW: '10.0.0.0/8, 192.168.1.7',
      ACENTRIC_CODE_PROCESSES: '4',
      OPENAI_API_KEY: 'sk-test',
      ANTHROPIC_API_KEY: ' ',
    });
    expect(settings).toMatchObject({
      port: 8080,
      host: '0.0.0.0',
      data: '/var/lib/acentric',
      adminKey: 'a-key-an-operator-keeps-somewhere-safe',
      network: { reach: 'public', allow: ['10.0.0.0/8', '192.168.1.7'] },
      codeProcesses: 4,
      // One that is given as nothing is not given.
      credentials: { openai: { type: 'api_key', apiKey: 'sk-test' } },
    });
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

  it('are refused, with which and why, before anything is started', () => {
    const wrong: [{ [name: string]: string }, RegExp][] = [
      [{ ACENTRIC_PORT: 'eighty' }, /ACENTRIC_PORT is a whole number/],
      [{ ACENTRIC_PORT: '70000' }, /ACENTRIC_PORT/],
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
    ];
    for (const [env, message] of wrong) {
      expect(() => readSettings(env), JSON.stringify(env)).toThrow(message);
    }
  });
});
