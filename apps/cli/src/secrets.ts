// An agent's secrets: what its code reads by name, such as a key of a service it calls. A
// secret is set and removed, and listed by its name. Nothing reads its value back.

import { agentOf, signedIn, withEngine } from './engine.ts';
import type { Io } from './engine.ts';
import { Fail } from './fail.ts';
import { table } from './render.ts';

export async function listSecrets(io: Io, given: { readonly agent: string }): Promise<void> {
  await withEngine(signedIn(io), async (client) => {
    const agent = await agentOf(client, given.agent);
    const { items } = await client.call('secrets.list', { params: { agent: agent.id } });
    if (items.length === 0) {
      io.out(`The agent ${agent.name} has no secrets.`);
      return;
    }
    const rows = items.map((secret) => [secret.name, new Date(secret.updatedAt).toISOString()]);
    for (const line of table(['NAME', 'SET'], rows)) io.out(line);
  });
}

export async function setSecret(
  io: Io,
  given: { readonly agent: string; readonly name: string; readonly value?: string | undefined },
): Promise<void> {
  const credentials = signedIn(io);
  // As it is given: a secret may begin or end with a space, and only what ends its line is not it.
  const value = given.value ?? (await io.secret(`Value of ${given.name}: `));
  if (value === '') throw new Fail('no value was given');
  await withEngine(credentials, async (client) => {
    const agent = await agentOf(client, given.agent);
    await client.call('secrets.set', {
      params: { agent: agent.id, name: given.name },
      body: { value },
    });
    io.out(`Set ${given.name} for the agent ${agent.name}.`);
  });
}

export async function removeSecret(
  io: Io,
  given: { readonly agent: string; readonly name: string },
): Promise<void> {
  await withEngine(signedIn(io), async (client) => {
    const agent = await agentOf(client, given.agent);
    await client.call('secrets.delete', { params: { agent: agent.id, name: given.name } });
    io.out(`Removed ${given.name} from the agent ${agent.name}.`);
  });
}
