// Signing in to a Claude plan through the API, as the dashboard does it, on a server that has
// Claude, with a stand-in for Claude Code's `claude` program; and a server that has none.

import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { claudeProvider } from '@acentric/ai/claude';

import { api, refusal } from './api.ts';

/** Claude, with a `claude` that takes the code `good-code`, and an SDK no call is made of. */
function claude() {
  const dir = mkdtempSync(join(tmpdir(), 'claude-api-'));
  const binary = join(dir, 'claude');
  writeFileSync(
    binary,
    `#!/bin/sh
case "$1 $2" in
  "auth status") if [ -f "$CLAUDE_CONFIG_DIR/in" ]; then echo '{"loggedIn": true, "email": "ada@example.test"}'; else echo '{"loggedIn": false}'; fi ;;
  "auth logout") rm -f "$CLAUDE_CONFIG_DIR/in" ;;
  "auth login")
    echo "https://claude.ai/oauth/authorize?z-abc"
    while true; do
      printf "Paste code here if prompted > "
      read code || exit 1
      if [ "$code" = "good-code" ]; then touch "$CLAUDE_CONFIG_DIR/in"; exit 0; fi
      echo "Invalid code"
    done ;;
esac
`,
  );
  chmodSync(binary, 0o755);
  const sdk = {
    query: () => {
      throw new Error('No model is called here');
    },
  };
  return claudeProvider({ sdk, binary, home: dir, env: { PATH: process.env['PATH'] } });
}

describe('a server that has Claude', () => {
  it('says it has it, and makes an account of a sign-in with the code Claude showed', async () => {
    const { admin, failures } = await api([], { claude: claude() });
    const providers = await admin.call('modelProviders.list', {});
    expect(providers.data.find((one) => one.id === 'claude')).toMatchObject({
      name: 'Claude',
      accounts: 'sign_in',
      defaultModel: 'claude-opus-5-5',
    });

    const signIn = await admin.call('claudeSignIns.create', { body: { name: 'plan' } });
    expect(signIn.url).toBe('https://claude.ai/oauth/authorize?z-abc');
    expect(await admin.call('claudeSignIns.get', { params: { signIn: signIn.id } })).toEqual(
      signIn,
    );

    // A code Claude does not take leaves it waiting.
    expect(
      await refusal(
        admin.call('claudeSignIns.finish', {
          params: { signIn: signIn.id },
          body: { code: 'nope' },
        }),
      ),
    ).toMatchObject({ status: 400, code: 'invalid_request' });
    const account = await admin.call('claudeSignIns.finish', {
      params: { signIn: signIn.id },
      body: { code: 'good-code' },
    });
    expect(account).toMatchObject({
      provider: 'claude',
      name: 'plan',
      credential: 'local_sign_in',
      signIn: { email: 'ada@example.test' },
      default: true,
    });
    // Finished: it waits no more.
    expect(
      await refusal(admin.call('claudeSignIns.get', { params: { signIn: signIn.id } })),
    ).toMatchObject({ status: 404 });
    expect(failures).toEqual([]);
  });

  it('gives a sign-in up', async () => {
    const { admin } = await api([], { claude: claude() });
    const signIn = await admin.call('claudeSignIns.create', { body: { name: 'plan' } });
    await admin.call('claudeSignIns.delete', { params: { signIn: signIn.id } });
    expect(
      await refusal(
        admin.call('claudeSignIns.finish', {
          params: { signIn: signIn.id },
          body: { code: 'good-code' },
        }),
      ),
    ).toMatchObject({ status: 404 });
  });
});

describe('a server that has no Claude', () => {
  it('lists no Claude, and starts no sign-in to it', async () => {
    const { admin } = await api([]);
    const providers = await admin.call('modelProviders.list', {});
    expect(providers.data.map((one) => one.id)).not.toContain('claude');
    expect(await refusal(admin.call('claudeSignIns.create', { body: { name: 'plan' } }))).toEqual({
      status: 400,
      code: 'invalid_request',
    });
  });
});
