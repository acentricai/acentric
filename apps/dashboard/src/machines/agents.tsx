// Which agents' actors may work on a machine: every agent (`*`), or those chosen. A machine is
// for none until it is given some. The server names an agent by its ID; a person reads its name.

import type { MachineAgents } from '@acentric/protocol';

import { useAgents } from './queries.ts';
import { displayText } from './text.tsx';
import { Field } from './ui.tsx';

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

export function AgentsField({
  value,
  onChange,
  disabled = false,
}: {
  value: MachineAgents;
  onChange: (value: MachineAgents) => void;
  disabled?: boolean;
}) {
  const agents = useAgents();
  const chosen = value === '*' ? [] : value;
  const names = new Map((agents.data ?? []).map((agent) => [agent.id, agent.name]));
  // An agent named on the machine that is not deployed is still shown, so it can be taken off.
  const known = [...new Set([...names.keys(), ...chosen])].toSorted((a, b) =>
    (names.get(a) ?? a).localeCompare(names.get(b) ?? b),
  );
  return (
    <Field label="Agents">
      {(id) => (
        <div className="agents-field" id={id} role="group">
          <label className="check">
            <input
              type="checkbox"
              checked={value === '*'}
              disabled={disabled}
              onChange={(event) => onChange(event.target.checked ? '*' : [])}
            />
            <span>All agents, and any deployed later</span>
          </label>
          {value !== '*' &&
            (known.length === 0 ? (
              <p className="note">
                {agents.isPending ? 'Loading agents…' : 'No agents deployed yet.'}
              </p>
            ) : (
              known.map((agent) => (
                <label key={agent} className="check">
                  <input
                    type="checkbox"
                    checked={chosen.includes(agent as never)}
                    disabled={disabled}
                    onChange={(event) =>
                      onChange(
                        (event.target.checked
                          ? [...chosen, agent].toSorted()
                          : chosen.filter((each) => each !== agent)) as MachineAgents,
                      )
                    }
                  />
                  <span className="mono">{displayText(names.get(agent) ?? agent)}</span>
                </label>
              ))
            ))}
        </div>
      )}
    </Field>
  );
}
