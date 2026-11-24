// Which agents' actors may work on a machine: every agent (`*`), or those chosen. The dashboard
// adds every machine and sandbox for every agent; one given some through the API says which. The
// server names an agent by its ID; a person reads its name.

import type { MachineAgents } from '@acentric/protocol';

import { useAgents } from './queries.ts';

/** The agents a machine is for, as a table cell says it: by their names where they are known. */
export function agentsText(agents: MachineAgents, names: ReadonlyMap<string, string>): string {
  if (agents === '*') return 'All agents';
  if (agents.length === 0) return 'None';
  return agents.map((agent) => names.get(agent) ?? agent).join(', ');
}

/** The agents' names, by their IDs: empty until they are read. */
export function useAgentNames(): ReadonlyMap<string, string> {
  const agents = useAgents();
  return new Map((agents.data ?? []).map((agent) => [agent.id, agent.name]));
}
