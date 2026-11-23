// The dashboard, as the server serves it: its files, and its page at every other address, with
// what keeps it to itself. The API's own paths are never the dashboard's.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DASHBOARD_HEADERS } from '../src/dashboard.ts';
import { api } from './api.ts';

/** A dashboard's build, as small as one is: its page, a built file and an image. */
function built(): string {
  const folder = mkdtempSync(join(tmpdir(), 'acentric-dashboard-'));
  mkdirSync(join(folder, 'assets'));
  mkdirSync(join(folder, 'art'));
  writeFileSync(join(folder, 'index.html'), '<!doctype html><title>Acentric</title>');
  writeFileSync(join(folder, 'assets', 'index-abc123.js'), 'console.log(1)');
  writeFileSync(join(folder, 'art', 'door.webp'), 'RIFF');
  // What is beside the build is not of it.
  writeFileSync(join(folder, '..', 'beside-the-dashboard.txt'), 'not yours');
  return folder;
}

describe('the dashboard', () => {
  it('is its page at every address that names no file of it, with what keeps it to itself', async () => {
    const { app } = await api([], { dashboard: built() });
    for (const path of ['/', '/sign-in', '/setup?token=al_x', '/reset?token=al_y', '/a/b/c']) {
      const answer = await app.request(path);
      expect(answer.status, path).toBe(200);
      expect(await answer.text(), path).toContain('<title>Acentric</title>');
      expect(answer.headers.get('content-type'), path).toBe('text/html; charset=utf-8');
      expect(answer.headers.get('cache-control'), path).toBe('no-cache');
      for (const [name, value] of Object.entries(DASHBOARD_HEADERS)) {
        expect(answer.headers.get(name), `${path} ${name}`).toBe(value);
      }
    }
    expect(DASHBOARD_HEADERS['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(DASHBOARD_HEADERS['Content-Security-Policy']).toContain("connect-src 'self'");
  });

  it('is its files, the built ones kept for good: their names change when they do', async () => {
    const { app } = await api([], { dashboard: built() });
    const script = await app.request('/assets/index-abc123.js');
    expect(await script.text()).toBe('console.log(1)');
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(script.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const art = await app.request('/art/door.webp');
    expect(art.headers.get('content-type')).toBe('image/webp');
    expect(art.headers.get('cache-control')).toBe('no-cache');
  });

  it('is nothing outside its folder, however the address is written', async () => {
    const { app } = await api([], { dashboard: built() });
    for (const path of [
      '/../beside-the-dashboard.txt',
      '/%2e%2e/beside-the-dashboard.txt',
      '/..%2fbeside-the-dashboard.txt',
      '/assets/..%2f..%2fbeside-the-dashboard.txt',
      '/%00',
      '/%E0%A4%A',
    ]) {
      const answer = await app.request(path);
      expect(await answer.text(), path).not.toContain('not yours');
    }
  });

  it('never stands for the API: what the API has not is said in its own way', async () => {
    const { app, admin } = await api([], { dashboard: built() });
    const missing = await app.request('/v1/nothing-here');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: 'not_found' } });
    expect((await app.request('/health')).headers.get('content-type')).toContain('json');
    expect((await admin.call('me.get')).type).toBe('key');
    // A request that is not to read is the API's alone.
    expect((await app.request('/sign-in', { method: 'POST' })).status).toBe(404);
  });

  it('is not served at all by a server told of none, nor started from a folder with none in it', async () => {
    const { app } = await api();
    expect((await app.request('/sign-in')).status).toBe(404);
    const empty = mkdtempSync(join(tmpdir(), 'acentric-no-dashboard-'));
    await expect(api([], { dashboard: empty })).rejects.toThrow(/has no index.html/);
  });
});
