// Model accounts: what the calls of a provider's models are made with. A key of the
// provider's, which the engine checks with the provider and keeps sealed.

import type { Client } from '@acentric/client';
import { parseId } from '@acentric/protocol';
import type { Account } from '@acentric/protocol';

import { signedIn, withEngine } from './engine.ts';
import type { Io } from './engine.ts';
import { Fail } from './fail.ts';
import { table } from './render.ts';

/** Every account of the engine. */
async function all(client: Client): Promise<Account[]> {
  const accounts: Account[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.call('accounts.list', {
      query: { limit: 200, ...(cursor === undefined ? {} : { cursor }) },
    });
    accounts.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return accounts;
}

export async function listAccounts(io: Io): Promise<void> {
  const accounts = await withEngine(signedIn(io), all);
  if (accounts.length === 0) {
    io.out('The engine has no model account. Add one: `acentric accounts add <provider> <name>`.');
    return;
  }
  const rows = accounts.map((account) => [
    account.name,
    account.provider,
    account.default ? 'yes' : '',
    String(account.agents.length),
    account.id,
  ]);
  for (const line of table(['NAME', 'PROVIDER', 'DEFAULT', 'AGENTS', 'ID'], rows)) io.out(line);
}

export async function addAccount(
  io: Io,
  given: {
    readonly provider: string;
    readonly name: string;
    readonly key?: string | undefined;
    readonly default: boolean;
  },
): Promise<void> {
  const credentials = signedIn(io);
  const apiKey = (given.key ?? (await io.secret(`API key of ${given.provider}: `))).trim();
  if (apiKey === '') throw new Fail('no key was given');
  const account = await withEngine(credentials, (client) =>
    client.call('accounts.create', {
      body: {
        provider: given.provider,
        name: given.name,
        apiKey,
        ...(given.default ? { default: true } : {}),
      },
    }),
  );
  io.out(
    `Added the account ${account.name} of ${account.provider}${account.default ? ', its default' : ''}. Its key was checked with ${account.provider}, and is kept sealed.`,
  );
}

export async function removeAccount(io: Io, given: { readonly account: string }): Promise<void> {
  await withEngine(signedIn(io), async (client) => {
    const named = given.account;
    const account =
      parseId(named)?.kind === 'account'
        ? await client.call('accounts.get', { params: { account: named as Account['id'] } })
        : (await all(client)).find((one) => one.name === named);
    if (account === undefined) throw new Fail(`the engine has no account ${named}`);
    await client.call('accounts.delete', { params: { account: account.id } });
    io.out(`Removed the account ${account.name} of ${account.provider}.`);
  });
}
