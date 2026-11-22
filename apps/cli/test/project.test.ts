import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  configDir,
  engineUrl,
  readCredentials,
  removeCredentials,
  writeCredentials,
} from '../src/credentials.ts';
import { Fail } from '../src/fail.ts';
import { checkAgentName, findProject, parseProject, writeProject } from '../src/project.ts';

const dir = mkdtempSync(join(tmpdir(), 'acentric-cli-unit-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('a project', () => {
  it('is the folder with acentric.json, found from anywhere inside it', () => {
    const root = join(dir, 'shop');
    mkdirSync(join(root, 'packages', 'review'), { recursive: true });
    expect(findProject(join(root, 'packages', 'review'))).toBeUndefined();
    writeProject({
      root,
      agents: [
        ['support', 'agents/support.ts'],
        ['reviewer', 'packages/review/agent.ts'],
      ],
    });
    expect(JSON.parse(readFileSync(join(root, 'acentric.json'), 'utf8'))).toEqual({
      agents: { support: 'agents/support.ts', reviewer: 'packages/review/agent.ts' },
    });
    expect(findProject(join(root, 'packages', 'review'))).toEqual({
      root,
      agents: [
        ['support', 'agents/support.ts'],
        ['reviewer', 'packages/review/agent.ts'],
      ],
    });
  });

  it('says what is wrong with an acentric.json that is not one', () => {
    const wrong = (text: string) => () => parseProject('/shop', text);
    expect(wrong('{')).toThrow('/shop/acentric.json is not JSON');
    expect(wrong('{}')).toThrow('has no "agents"');
    expect(wrong('{"agents":["support"]}')).toThrow('has no "agents"');
    expect(wrong('{"agents":{"Support":"a.ts"}}')).toThrow(
      'names an agent "Support", which is not an agent\'s name',
    );
    expect(wrong('{"agents":{"support":""}}')).toThrow('gives no file for the agent support');
  });

  it('names its agents as the engine names things: never as an ID reads', () => {
    expect(checkAgentName('support-2')).toBe('support-2');
    for (const name of ['Support', '', '-support', 'a'.repeat(64), 'two words']) {
      expect(() => checkAgentName(name), name).toThrow(Fail);
    }
    // What has the form of an ID is no name: a command given either can tell which it was.
    expect(() => checkAgentName('agt_01jd8w3k5xfq0v9m2r6t4y7z1b')).toThrow(Fail);
  });
});

describe('where the command is signed in', () => {
  it('is an engine’s address, kept as its origin, and a path only when it has one', () => {
    expect(engineUrl('engine.example.com')).toBe('https://engine.example.com');
    expect(engineUrl('http://127.0.0.1:4000/')).toBe('http://127.0.0.1:4000');
    expect(engineUrl('https://example.com/engine//')).toBe('https://example.com/engine');
    expect(() => engineUrl('ftp://example.com')).toThrow("is not an engine's address");
    expect(() => engineUrl('http://')).toThrow("is not an engine's address");
  });

  it('is kept in a file only its owner reads, and forgotten when signed out', () => {
    const env = { HOME: join(dir, 'home') };
    expect(configDir(env)).toBe(join(dir, 'home', '.config', 'acentric'));
    expect(configDir({ ...env, XDG_CONFIG_HOME: '/x' })).toBe('/x/acentric');
    expect(configDir({ ...env, XDG_CONFIG_HOME: '/x', ACENTRIC_CONFIG_DIR: '/own' })).toBe('/own');

    expect(readCredentials(env)).toBeUndefined();
    const file = writeCredentials(env, { engine: 'https://engine.example.com', key: 'ak_one' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(configDir(env)).mode & 0o777).toBe(0o700);
    expect(readCredentials(env)).toEqual({ engine: 'https://engine.example.com', key: 'ak_one' });
    expect(removeCredentials(env)).toBe(true);
    expect(removeCredentials(env)).toBe(false);
    expect(readCredentials(env)).toBeUndefined();
  });

  it('is what the environment says in its place, as CI does', () => {
    const env = { HOME: join(dir, 'ci') };
    const both = { ...env, ENGINE_URL: 'engine.example.com/', ENGINE_API_KEY: 'ak_ci' };
    expect(readCredentials(both)).toEqual({ engine: 'https://engine.example.com', key: 'ak_ci' });
    // One of the two alone says nothing.
    expect(readCredentials({ ...env, ENGINE_URL: 'engine.example.com' })).toBeUndefined();
    expect(readCredentials({ ...env, ENGINE_API_KEY: 'ak_ci' })).toBeUndefined();
    // A key alone is used with the engine that was signed in to.
    writeCredentials(env, { engine: 'https://kept.example.com', key: 'ak_kept' });
    expect(readCredentials({ ...env, ENGINE_API_KEY: 'ak_ci' })).toEqual({
      engine: 'https://kept.example.com',
      key: 'ak_ci',
    });
  });

  it('says so when its file cannot be read as one', () => {
    const env = { HOME: join(dir, 'broken') };
    const file = writeCredentials(env, { engine: 'https://engine.example.com', key: 'ak_one' });
    writeFileSync(file, '{"engine": 4}');
    expect(() => readCredentials(env)).toThrow('cannot be read');
    writeFileSync(file, 'not json');
    expect(() => readCredentials(env)).toThrow('cannot be read');
  });
});
