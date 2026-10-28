// The inputs part's snapshot part: messages waiting for their turn, and the
// log a step needs to see to give them it.

export type InputsState = {
  /** Seqs of messages that arrived while busy, oldest first. */
  queue: number[];
};

export const INITIAL_INPUTS: InputsState = { queue: [] };

/** The first seq a step needs: the oldest queued message. Infinity when none is queued. */
export function inputsWindow(state: InputsState): number {
  return Math.min(...state.queue);
}
