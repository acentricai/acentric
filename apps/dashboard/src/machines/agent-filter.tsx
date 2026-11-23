// The Machines page's Agents filter: the agents deployed, each with a checkbox, and beside the one
// under the pointer, or whose arrow is pressed, its actors that are not archived. The machines
// shown are those the actors of the agents chosen work on, and those of the actors chosen.

import { IconChevronRight } from '@tabler/icons-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';

import { useActiveActors, useActorNames, useAgents } from './queries.ts';
import { FilterOption, FilterPill } from './ui.tsx';

/** How long the pointer may be off an agent and its actors before they are put away. */
const LEAVE_MS = 200;

/** Where the actors of an agent are drawn, from the top and left of the chip. */
type Beside = { agent: string; name: string; top: number; left: number; focus: boolean };

export function AgentFilter({
  agents,
  actors,
  onToggleAgent,
  onToggleActor,
  onClear,
}: {
  /** The agents chosen. */
  agents: readonly string[];
  /** The actors chosen. */
  actors: readonly string[];
  onToggleAgent: (agent: string) => void;
  onToggleActor: (actor: string) => void;
  onClear: () => void;
}) {
  const list = useAgents();
  const actorNames = useActorNames(actors);
  const [beside, setBeside] = useState<Beside | null>(null);
  const leaving = useRef<ReturnType<typeof setTimeout>>(undefined);
  const arrows = useRef(new Map<string, HTMLButtonElement>());
  const id = useId();
  useEffect(() => () => clearTimeout(leaving.current), []);

  const agentName = (agent: string) => list.data?.find((one) => one.id === agent)?.name ?? agent;
  const labels = [
    ...agents.map(agentName),
    ...actors.map((actor) => actorNames.get(actor) ?? actor),
  ];

  const stay = () => clearTimeout(leaving.current);
  const leave = () => {
    clearTimeout(leaving.current);
    leaving.current = setTimeout(() => {
      // What the keyboard is in is not put away from under it.
      setBeside((now) =>
        now !== null && document.getElementById(id)?.contains(document.activeElement) === true
          ? now
          : null,
      );
    }, LEAVE_MS);
  };
  /** Shows an agent's actors beside its row, which is in the list, which is in the chip. */
  const show = (agent: string, name: string, row: HTMLElement, focus = false) => {
    stay();
    const pop = row.closest('.filter-chip__pop')?.getBoundingClientRect();
    const chip = row.closest('.filter-chip')?.getBoundingClientRect();
    if (pop === undefined || chip === undefined) return;
    // Its first actor level with the agent: the list's padding and heading are above it.
    const top = row.getBoundingClientRect().top - chip.top - 7;
    setBeside({ agent, name, top, left: pop.right - chip.left + 4, focus });
  };

  return (
    <FilterPill
      name="Agents"
      labels={labels}
      onClear={onClear}
      onClose={() => {
        stay();
        setBeside(null);
      }}
      aside={
        beside !== null && (
          <ActorsBeside
            id={id}
            beside={beside}
            chosen={actors}
            onToggle={onToggleActor}
            onEnter={stay}
            onLeave={leave}
            onBack={() => {
              arrows.current.get(beside.agent)?.focus();
              setBeside(null);
            }}
          />
        )
      }
    >
      {list.isPending && <p className="filter-chip__none">Loading…</p>}
      {list.isError && <p className="filter-chip__none">The agents could not be read.</p>}
      {list.data?.length === 0 && <p className="filter-chip__none">No agents are deployed.</p>}
      {list.data?.map((agent) => {
        const open = beside?.agent === agent.id;
        const row = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) =>
          event.currentTarget.closest<HTMLElement>('.filter-chip__row');
        return (
          <div
            key={agent.id}
            className="filter-chip__row"
            data-open={open || undefined}
            onMouseEnter={(event) => show(agent.id, agent.name, event.currentTarget)}
            onMouseLeave={leave}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowRight') return;
              const at = row(event);
              if (at === null) return;
              event.preventDefault();
              show(agent.id, agent.name, at, true);
            }}
          >
            <FilterOption
              label={agent.name}
              on={agents.includes(agent.id)}
              onToggle={() => onToggleAgent(agent.id)}
            />
            <button
              ref={(button) => {
                if (button === null) arrows.current.delete(agent.id);
                else arrows.current.set(agent.id, button);
              }}
              type="button"
              className="filter-chip__more"
              aria-label={`Actors of ${agent.name}`}
              aria-expanded={open}
              aria-controls={open ? id : undefined}
              onClick={(event) => {
                const at = row(event);
                if (open) setBeside(null);
                else if (at !== null) show(agent.id, agent.name, at, event.detail === 0);
              }}
            >
              <IconChevronRight size={14} stroke={1.75} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </FilterPill>
  );
}

function ActorsBeside({
  id,
  beside,
  chosen,
  onToggle,
  onEnter,
  onLeave,
  onBack,
}: {
  id: string;
  beside: Beside;
  chosen: readonly string[];
  onToggle: (actor: string) => void;
  onEnter: () => void;
  onLeave: () => void;
  /** Back to the agent, from the keyboard. */
  onBack: () => void;
}) {
  const actors = useActiveActors(beside.agent);
  const ref = useRef<HTMLDivElement>(null);
  const focus = beside.focus;
  const ready = actors.data !== undefined;
  useEffect(() => {
    if (focus && ready) ref.current?.querySelector<HTMLElement>('input')?.focus();
  }, [focus, ready, beside.agent]);
  return (
    <div
      ref={ref}
      id={id}
      role="group"
      aria-label={`Active actors of ${beside.name}`}
      className="pop filter-chip__beside"
      style={{ top: beside.top, left: beside.left }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft') return;
        event.preventDefault();
        onBack();
      }}
    >
      <p className="pop__heading">Active actors</p>
      {actors.isPending && <p className="filter-chip__none">Loading…</p>}
      {actors.isError && <p className="filter-chip__none">The actors could not be read.</p>}
      {actors.data?.length === 0 && <p className="filter-chip__none">No active actors.</p>}
      {actors.data?.map((actor) => (
        <FilterOption
          key={actor.id}
          label={actor.name ?? actor.id}
          on={chosen.includes(actor.id)}
          onToggle={() => onToggle(actor.id)}
        />
      ))}
    </div>
  );
}
