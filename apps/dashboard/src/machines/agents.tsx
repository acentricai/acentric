// The agents' names, by their IDs, for the pages that name an agent the server gives by its ID.

import { useAgents } from './queries.ts';

/** The agents' names, by their IDs: empty until they are read. */
export function useAgentNames(): ReadonlyMap<string, string> {
  const agents = useAgents();
  return new Map((agents.data ?? []).map((agent) => [agent.id, agent.name]));
}
