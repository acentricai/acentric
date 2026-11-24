// What the server connects to for an agent, from its own process: as far as agents' code may
// reach, and no further.

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fetchWithin, reachable } from '../src/index.ts';

const PUBLIC = { reach: 'public' } as const;

describe('the addresses an agent may reach', () => {
  it('are public ones, with `public`', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
      expect(reachable(PUBLIC, address), address).toBe(true);
    }
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      '::',
      '::ffff:127.0.0.1',
      '::ffff:169.254.169.254',
      'fd00::1',
      'fe80::1',
      '64:ff9b::a00:1',
      'not an address',
    ]) {
      expect(reachable(PUBLIC, address), address).toBe(false);
    }
  });

  it('are the private ones allowed too, and every one with `any`', () => {
    const allowed = { reach: 'public', allow: ['10.0.0.0/8', '192.168.1.5'] } as const;
    expect(reachable(allowed, '10.1.2.3')).toBe(true);
    expect(reachable(allowed, '192.168.1.5')).toBe(true);
    expect(reachable(allowed, '192.168.1.6')).toBe(false);
    expect(reachable(allowed, '127.0.0.1')).toBe(false);
    expect(reachable({ reach: 'any' }, '127.0.0.1')).toBe(true);
    expect(reachable({ reach: 'any' }, '169.254.169.254')).toBe(true);
  });
});

describe('a fetch within the network', () => {
  let server: Server;
  let port: number;
  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/elsewhere') {
        // To this machine again, by its other address.
        response.writeHead(302, { location: `http://[::1]:${String(port)}/` });
        response.end();
        return;
      }
      response.end('here');
    });
    await new Promise<void>((resolve) => server.listen(0, '::', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const refusal = async (made: Promise<Response>): Promise<string> => {
    const error = await made.then(
      () => undefined,
      (failed: unknown) => failed,
    );
    expect(error).toBeInstanceOf(Error);
    const { message, cause } = error as Error & { cause?: Error };
    return `${message} ${cause?.message ?? ''}`;
  };

  it('does not connect to this machine with `public`, by its address or by a name', async () => {
    const within = fetchWithin(PUBLIC);
    expect(await refusal(within(`http://127.0.0.1:${String(port)}/`))).toContain(
      'is not an address agents may reach',
    );
    expect(await refusal(within(`http://[::1]:${String(port)}/`))).toContain(
      'is not an address agents may reach',
    );
    expect(await refusal(within(`http://localhost:${String(port)}/`))).toContain(
      'is not an address agents may reach',
    );
  });

  it('connects to an address allowed, and not to where it redirects that is not', async () => {
    const within = fetchWithin({ reach: 'public', allow: ['127.0.0.1'] });
    const answered = await within(`http://127.0.0.1:${String(port)}/`);
    expect(await answered.text()).toBe('here');
    expect(await refusal(within(`http://127.0.0.1:${String(port)}/elsewhere`))).toContain(
      'is not an address agents may reach',
    );
  });

  it('connects anywhere with `any`, following a redirect', async () => {
    const within = fetchWithin({ reach: 'any' });
    const answered = await within(`http://127.0.0.1:${String(port)}/elsewhere`);
    expect(await answered.text()).toBe('here');
  });
});
