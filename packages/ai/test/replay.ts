// Answering for a provider from what was recorded of it (see `record.ts`).

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Credential } from '../src/index.ts';
import type { Fixture } from './record.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export function fixture(provider: string, scenario: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURES, provider, `${scenario}.json`), 'utf8')) as Fixture;
}

/** Every fixture of a provider, by its scenario. */
export function fixturesOf(provider: string): Fixture[] {
  return readdirSync(join(FIXTURES, provider))
    .filter((file) => file.endsWith('.json'))
    .toSorted()
    .map((file) => fixture(provider, file.slice(0, -'.json'.length)));
}

/** A credential of the kind a provider takes, that is nobody's. */
export function credentialFor(provider: string): Credential {
  return provider === 'chatgpt'
    ? { type: 'access_token', accessToken: 'a-token' }
    : { type: 'api_key', apiKey: 'a-key' };
}

export type Sent = {
  readonly url: string;
  readonly headers: { readonly [name: string]: string };
  readonly body: { readonly [field: string]: unknown };
};

/**
 * A `fetch` that answers with what was recorded, and keeps what it was sent. The headers that
 * sign a call are kept as `<redacted>`, as they were recorded.
 */
export function answering(response: Fixture['response']): {
  readonly fetch: typeof fetch;
  readonly sent: Sent[];
} {
  const sent: Sent[] = [];
  return {
    sent,
    fetch: async (input, init) => {
      const headers = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as { [name: string]: string }).map(([name, value]) => [
          name,
          ['authorization', 'x-api-key'].includes(name.toLowerCase()) ? '<redacted>' : value,
        ]),
      );
      sent.push({
        url: String(input),
        headers,
        body: JSON.parse(String(init?.body)) as Sent['body'],
      });
      return new Response(response.text, { status: response.status, headers: response.headers });
    },
  };
}
