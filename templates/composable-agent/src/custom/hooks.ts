// The custom part's side of the loop: told when a turn starts and when the
// agent goes idle, the results of effects whose keys it made, and the
// effects it wants running. Meals' cache warming would start a timer when
// the agent goes idle, drop it when a turn starts, and send a warm-up when
// it fires. These do nothing until the agent has behaviour of its own.
//
// Its keys must not collide with the loop's (llm:7, tool:8, ...): give them
// a prefix of their own, such as warm:, and say so in ownsKey.

import type { EffectRequest, LogAppend, Outcome } from '@acentric/types';

import type { RunnerKinds } from '../core/kinds.js';
import type { CustomSettings } from './settings.js';
import type { CustomState } from './state.js';

/** The effect kinds of the agent's own behaviour. Empty until it has some. */
// oxlint-disable-next-line typescript/no-empty-object-type -- an agent adds its kinds here
export type CustomKinds = {};

/** The custom kinds' names, for the agent's list of kinds. */
export const CUSTOM_KINDS: (keyof CustomKinds)[] = [];

/** The custom part when a turn starts. */
export function onTurnStart(state: CustomState, _now: number): CustomState {
  return state;
}

/** The custom part when the agent goes idle. */
export function onIdle(state: CustomState, _now: number, _settings: CustomSettings): CustomState {
  return state;
}

/** Whether an effect key is one the custom part made. */
export function ownsKey(_key: string): boolean {
  return false;
}

/** The custom part once one of its effects reported, and any entries to append. */
export function onEffect(
  state: CustomState,
  _key: string,
  _outcome: Outcome,
  _now: number,
  _settings: CustomSettings,
): { state: CustomState; append: LogAppend[] } {
  return { state, append: [] };
}

/** The effects the custom part wants running, in any phase. */
export function customEffects(
  _state: CustomState,
  _settings: CustomSettings,
): EffectRequest<CustomKinds & RunnerKinds>[] {
  return [];
}
