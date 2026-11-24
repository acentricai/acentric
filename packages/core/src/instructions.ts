// An actor's own instructions: what its agent's code makes of what the actor was created
// with, when the agent's instructions are a function and not text.
//
// They are made when the actor is created, and kept with it. They are made again only when it
// moves to another version of its agent, which is between turns: they never change in a turn.

import type { AgentDefinition, DeploymentId } from '@acentric/protocol';

import type { CallContext, CallResult } from './executor.ts';

/** The feature of an agent whose code makes each actor's instructions. */
export const ACTOR_INSTRUCTIONS = 'actor-instructions';

/** Whether an agent's code makes each actor's instructions, in place of text for all of them. */
export const makesInstructions = (definition: AgentDefinition): boolean =>
  definition.features?.includes(ACTOR_INSTRUCTIONS) === true;

/**
 * Has a deployment's code make an actor's instructions. `lost` when the code could not be
 * reached, which says nothing of whether it would make them.
 */
export async function makeInstructions(
  call: (
    deployment: DeploymentId,
    path: string,
    argument: null,
    context: CallContext,
    signal: AbortSignal,
  ) => Promise<CallResult>,
  deployment: DeploymentId,
  context: CallContext,
): Promise<
  | { readonly ok: true; readonly instructions: string }
  | { readonly ok: false; readonly lost: boolean; readonly why: string }
> {
  const made = await call(
    deployment,
    'instructions.make',
    null,
    context,
    new AbortController().signal,
  );
  if (made.ok) {
    if (typeof made.value === 'string') return { ok: true, instructions: made.value };
    return { ok: false, lost: false, why: 'it returned what is not text' };
  }
  if (made.kind === 'lost') return { ok: false, lost: true, why: made.reason };
  if (made.kind === 'error') return { ok: false, lost: false, why: made.error.message };
  return { ok: false, lost: false, why: 'it takes nothing' };
}
