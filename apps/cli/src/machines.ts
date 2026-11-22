// Machines: the computers actors' commands run on. One is added here, which gives the command
// to run on that computer: it installs the machine program from the engine, enrols, and stays
// connected.

import type { Client } from '@acentric/client';
import { parseId } from '@acentric/protocol';
import type { AgentId, Machine, MachineAgents } from '@acentric/protocol';

import { agentOf, signedIn, withEngine } from './engine.ts';
import type { Io } from './engine.ts';
import { Fail } from './fail.ts';
import { table } from './render.ts';

/** The machine of a name, or of an ID. */
export async function machineOf(client: Client, given: string): Promise<Machine> {
  if (parseId(given)?.kind === 'machine') {
    return client.call('machines.get', { params: { machine: given as Machine['id'] } });
  }
  const { items } = await client.call('machines.list', { query: { name: given as never } });
  const [machine] = items;
  if (machine === undefined) throw new Fail(`the engine has no machine ${given}`);
  return machine;
}

/** How a machine stands, in a word or two. */
function standing(machine: Machine): string {
  if (!machine.enrolled) return 'not installed';
  return machine.online ? 'online' : 'offline';
}

/** The machine program a machine runs, and whether the engine has a newer one. */
function program(machine: Machine): string {
  if (machine.version === null) return '';
  return machine.current === false ? `${machine.version} (update available)` : machine.version;
}

export async function listMachines(io: Io): Promise<void> {
  const { items } = await withEngine(signedIn(io), (client) => client.call('machines.list'));
  if (items.length === 0) {
    io.out('The engine has no machine. Add one: `acentric machines add <name> --agent <agent>`.');
    return;
  }
  const rows = items.map((machine) => [
    machine.name,
    standing(machine),
    machine.os === null ? '' : `${machine.os}-${machine.arch ?? '?'}`,
    program(machine),
    machine.agents === '*' ? 'all' : String(machine.agents.length),
    machine.id,
  ]);
  for (const line of table(['NAME', 'STATUS', 'SYSTEM', 'PROGRAM', 'AGENTS', 'ID'], rows)) {
    io.out(line);
  }
}

/** The command that installs the machine program on a computer, and enrols it as a machine. */
export function installCommand(engine: string, machine: string, token: string): string {
  return `curl -fsSL ${engine}/install.sh | sh -s -- --id ${machine} --token ${token}`;
}

export async function addMachine(
  io: Io,
  given: {
    readonly name: string;
    /** The agents it is for, by name or ID. */
    readonly agents: readonly string[];
    /** It is for every agent. */
    readonly allAgents: boolean;
  },
): Promise<void> {
  const credentials = signedIn(io);
  if (given.allAgents === given.agents.length > 0) {
    throw new Fail(
      'say which agents the machine is for',
      '`--agent <agent>`, once for each, or `--all-agents`',
    );
  }
  await withEngine(credentials, async (client) => {
    let agents: MachineAgents = '*';
    const names: string[] = [];
    if (!given.allAgents) {
      const ids: AgentId[] = [];
      for (const named of given.agents) {
        const agent = await agentOf(client, named);
        ids.push(agent.id);
        names.push(agent.name);
      }
      agents = ids;
    }
    const added = await client.call('machines.create', {
      body: { name: given.name as never, agents },
    });
    const minutes = Math.round((added.expiresAt - Date.now()) / 60_000);
    io.out(
      `Added the machine ${added.machine.name}, for ${
        given.allAgents ? 'every agent' : names.join(', ')
      }.`,
    );
    io.out('');
    io.out('On the computer it is, run:');
    io.out('');
    io.out(`  ${installCommand(credentials.engine, added.machine.id, added.token)}`);
    io.out('');
    io.out(
      `It installs the machine program, and keeps it connected. The token works once, for ${String(minutes)} minutes.`,
    );
  });
}

export async function removeMachine(io: Io, given: { readonly machine: string }): Promise<void> {
  await withEngine(signedIn(io), async (client) => {
    const machine = await machineOf(client, given.machine);
    await client.call('machines.delete', { params: { machine: machine.id } });
    io.out(
      `Removed the machine ${machine.name}. Its program is still on that computer: \`curl -fsSL <engine>/install.sh | sh -s -- --uninstall\` removes it there.`,
    );
  });
}

/** Has machines take the machine program the engine hands out: one, or every one that is connected. */
export async function updateMachines(
  io: Io,
  given: { readonly machine: string | undefined; readonly all: boolean },
): Promise<void> {
  if (given.all === (given.machine !== undefined)) {
    throw new Fail('machines update takes a machine, or `--all`');
  }
  await withEngine(signedIn(io), async (client) => {
    const machines =
      given.machine === undefined
        ? (await client.call('machines.list')).items
        : [await machineOf(client, given.machine)];
    if (machines.length === 0) {
      io.out('The engine has no machine.');
      return;
    }
    let failed = 0;
    for (const machine of machines) {
      // With `--all`, one that is away is passed over, and said.
      if (given.machine === undefined && !machine.online) {
        io.out(`${machine.name}: ${standing(machine)}, not updated`);
        continue;
      }
      try {
        const { updated, machine: now } = await client.call('machines.upgrade', {
          params: { machine: machine.id },
        });
        io.out(
          updated
            ? `${machine.name}: updated to ${now.version ?? 'the engine’s'}`
            : `${machine.name}: up to date (${now.version ?? 'unknown'})`,
        );
      } catch (error) {
        failed += 1;
        io.out(`${machine.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failed > 0) {
      throw new Fail(`${String(failed)} of ${String(machines.length)} could not be updated`);
    }
  });
}
