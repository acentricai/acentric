// The address of an actor's ID alone, as a link made without its agent has it: once the actor
// is read, its page among its agent's Actors, with what the address asked for kept.

import { useLocation, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import { actorPath } from '../links.tsx';
import { useActor } from '../queries.ts';
import { ActorPage } from './actor.tsx';

export function ActorRedirect() {
  const { actor } = useParams({ strict: false }) as { actor: string };
  const read = useActor(actor);
  const navigate = useNavigate();
  // The query and the place in its conversation, as they were written.
  const { searchStr, hash } = useLocation();
  const agent = read.data?.agent;
  useEffect(() => {
    if (agent === undefined) return;
    const to = `${actorPath(actor, agent) as string}${searchStr}${hash === '' ? '' : `#${hash}`}`;
    void navigate({ href: to, replace: true });
  }, [actor, agent, hash, navigate, searchStr]);
  // One that is not there, or not to be read, is said so where it would be. Once it is, it
  // stays: the page reads the actor again, which would have this wait once more.
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (read.isError) setFailed(true);
  }, [read.isError]);
  return failed ? <ActorPage /> : null;
}
