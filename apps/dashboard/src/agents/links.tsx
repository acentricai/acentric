// Where an agent's and an actor's pages are, and links to them. The routes are made at run time
// from the sections, so their paths are written here, whole.

import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

export const agentPath = (agent: string, tab = '') =>
  `/agents/${encodeURIComponent(agent)}${tab === '' ? '' : `/${tab}`}` as never;

/**
 * An actor's page, among its agent's Actors. Without its agent, the address that finds the
 * agent and goes there: for a link made from an actor's ID alone.
 */
export const actorPath = (actor: string, agent?: string) =>
  (agent === undefined
    ? `/actors/${encodeURIComponent(actor)}`
    : `/agents/${encodeURIComponent(agent)}/actors/${encodeURIComponent(actor)}`) as never;

type LinkProps = {
  readonly className?: string;
  readonly title?: string | undefined;
  readonly children: ReactNode;
};

export function AgentLink({ agent, ...props }: LinkProps & { agent: string }) {
  return <Link to={agentPath(agent)} {...props} />;
}

export function ActorLink({
  actor,
  agent,
  ...props
}: LinkProps & { actor: string; agent?: string | undefined }) {
  return <Link to={actorPath(actor, agent)} {...props} />;
}
