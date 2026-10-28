// The inputs part's snapshot part: messages that arrived during a turn and
// are waiting for theirs, and the log a step needs to see to give it them.
// Both lists point at `queued` entries in the log.

export type InputsState = {
  /** Seqs of messages to give the model at its next call, oldest first. */
  steering: number[];
  /** Seqs of messages to start the next turn with, oldest first. */
  queued: number[];
};

export const INITIAL_INPUTS: InputsState = { steering: [], queued: [] };

/** The first seq a step needs: the oldest waiting message. Infinity when none is waiting. */
export function inputsWindow(state: InputsState): number {
  return Math.min(...state.steering, ...state.queued);
}
