// Where an agent's and an actor's pages are, and links to them. The routes are made at run time
// from the sections, so their paths are written here, whole.

import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

export const agentPath = (agent: string, tab = '') =>
  `/agents/${encodeURIComponent(agent)}${tab === '' ? '' : `/${tab}`}` as never;

export const actorPath = (actor: string) => `/actors/${encodeURIComponent(actor)}` as never;

type LinkProps = {
  readonly className?: string;
  readonly title?: string | undefined;
  readonly children: ReactNode;
};

export function AgentLink({ agent, ...props }: LinkProps & { agent: string }) {
  return <Link to={agentPath(agent)} {...props} />;
}

export function ActorLink({ actor, ...props }: LinkProps & { actor: string }) {
  return <Link to={actorPath(actor)} {...props} />;
}
