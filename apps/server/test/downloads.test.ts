// What the server hands out to be installed elsewhere: the command, and the script that
// installs it.

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { COMMAND_HEADER } from '@acentric/protocol';
import { Hono } from 'hono';
import { afterAll, describe, expect, it } from 'vitest';

import { serveDownloads } from '../src/downloads.ts';
import { readSettings, start } from '../src/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'acentric-downloads-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const folder = join(dir, 'downloads');
const SCRIPT = '#!/bin/sh\nSERVER=\'__SERVER__\'\ncurl "$SERVER/acentric.mjs"\n';

function served(publicUrl?: string): Hono {
  const app = new Hono();
  serveDownloads(app, { folder, publicUrl });
  return app;
}

describe('what the server hands out', () => {
  it('is not handed out by a server told a folder without it, which says what is missing', () => {
    expect(() => served()).toThrow(/has no install-cli\.sh: it is apps\/cli\/install\.sh/);
  });

  it('is the script with the server’s address in it, and the command, to anyone', async () => {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'install-cli.sh'), SCRIPT);
    expect(() => served()).toThrow(/has no acentric\.mjs/);
    writeFileSync(join(folder, 'acentric.mjs'), '// the command\n');

    const app = served();
    const script = await app.request('http://engine.test:4000/install-cli.sh');
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toBe('text/x-shellscript; charset=utf-8');
    expect(script.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await script.text()).toBe(SCRIPT.replace('__SERVER__', 'http://engine.test:4000'));

    const command = await app.request('http://engine.test:4000/acentric.mjs');
    expect(command.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await command.text()).toBe('// the command\n');
  });

  it('says the address it is reached at from outside: its public one, or what a proxy says', async () => {
    const proxied = await served().request('http://10.0.0.7:4000/install-cli.sh', {
      headers: { host: 'engine.example.com', 'x-forwarded-proto': 'https' },
    });
    expect(await proxied.text()).toContain("SERVER='https://engine.example.com'");
    const given = await served('https://agents.example.com/').request(
      'http://10.0.0.7:4000/install-cli.sh',
    );
    expect(await given.text()).toContain("SERVER='https://agents.example.com'");
  });

  it('never writes into the script an address that could break out of its quotes', async () => {
    const response = await served().request('http://engine.test/install-cli.sh', {
      headers: { host: "engine.test';rm -rf ~;'" },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });
});

describe('a server', () => {
  it('hands out nothing unless it is told a folder, and does not start with one that lacks the files', async () => {
    const settings = (more: { readonly [name: string]: string }) =>
      readSettings({
        ACENTRIC_PORT: '0',
        ACENTRIC_DATA: join(dir, 'data'),
        ACENTRIC_CODE_PROCESSES: '1',
        ...more,
      });
    await expect(
      start(settings({ ACENTRIC_DOWNLOADS: join(dir, 'nothing-here') }), {
        version: 'test',
        log: () => {},
      }),
    ).rejects.toThrow(/has no install-cli\.sh/);

    const without = await start(settings({}), { version: 'test', log: () => {} });
    expect((await fetch(`${without.server.url}/install-cli.sh`)).status).toBe(404);
    expect((await fetch(`${without.server.url}/health`)).headers.get(COMMAND_HEADER)).toBeNull();
    await without.close();

    const withIt = await start(settings({ ACENTRIC_DOWNLOADS: folder }), {
      version: 'test',
      log: () => {},
    });
    const script = await fetch(`${withIt.server.url}/install-cli.sh`);
    expect(await script.text()).toContain(`SERVER='${withIt.server.url}'`);

    // Every answer says which command the server hands out, by the digest of its file: one
    // that is up, one that is refused, one of no route, and the command itself.
    const digest = createHash('sha256').update('// the command\n').digest('hex');
    for (const path of ['/health', '/v1/me', '/v1/nothing-here', '/acentric.mjs']) {
      const answer = await fetch(`${withIt.server.url}${path}`);
      expect(answer.headers.get(COMMAND_HEADER), path).toBe(digest);
    }
    await withIt.close();
  }, 60_000);
});
