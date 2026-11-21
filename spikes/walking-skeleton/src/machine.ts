// THROWAWAY. The turn machine: given where an actor stands and something that happened, what
// is stored. It reads no clock, calls nothing and waits for nothing, so every case of it is
// tested without a store, a model or an agent.
//
// It returns the change and no list of things to do. What is to be done next is read off the
// state it stored (see `Turn`), which is what a restart reads too.

import type { ConversationEntry, Input, Message, ToolResultMessage } from '@acentric/protocol';

import type { ActorRecord, Change, ModelAnswer, OwedCall } from './interfaces.ts';

export type MachineEvent =
  /** The actor is idle and has mail: a turn starts with it. */
  | { readonly type: 'wake'; readonly inputs: readonly Input[] }
  /** The model answered. */
  | { readonly type: 'answered'; readonly answer: ModelAnswer }
  /** The call of the model failed. */
  | { readonly type: 'model_failed'; readonly reason: string }
  /** One of the tool calls that are owed was answered. */
  | { readonly type: 'tool_finished'; readonly call: string; readonly result: ToolResultMessage }
  /** Every tool call was answered: the turn goes back to the model, with any mail that came. */
  | { readonly type: 'continue'; readonly inputs: readonly Input[] };

/** The event does not follow from where the actor stands. */
export class OutOfTurn extends Error {
  override readonly name = 'OutOfTurn';
}

export function decide(record: ActorRecord, event: MachineEvent, now: number): Change {
  const { actor, turn } = record;
  let seq = record.nextSeq;
  const entry = (message: Message, more: Partial<ConversationEntry> = {}): ConversationEntry => ({
    seq: seq++,
    message,
    createdAt: now,
    ...more,
  });
  const mail = (inputs: readonly Input[]): ConversationEntry[] =>
    inputs.map((input) => entry(input.message, { input: { id: input.id, type: input.type } }));
  const refused = (): never => {
    throw new OutOfTurn(`${event.type} does not follow from ${turn.phase}`);
  };
  const working = { at: now, status: 'working', lastTurn: actor.lastTurn } as const;
  const ended = (end: 'ok' | 'failed' | 'refused', reason?: string): Change => ({
    at: now,
    status: 'idle',
    lastTurn: { end, at: now, ...(reason === undefined ? {} : { reason }) },
    turn: { phase: 'idle' },
    append: [],
    deliver: [],
  });

  switch (event.type) {
    case 'wake': {
      if (turn.phase !== 'idle' || event.inputs.length === 0) return refused();
      return {
        ...working,
        turn: { phase: 'model' },
        append: mail(event.inputs),
        deliver: event.inputs.map((input) => input.id),
      };
    }

    case 'answered': {
      if (turn.phase !== 'model') return refused();
      const { answer } = event;
      const said = entry(answer.message, {
        completion: {
          stopReason: answer.stopReason,
          ...(answer.usage === undefined ? {} : { usage: answer.usage }),
        },
      });
      if (answer.toolCalls.length > 0) {
        const calls: OwedCall[] = answer.toolCalls.map((call) => ({ ...call, result: null }));
        return { ...working, turn: { phase: 'tools', calls }, append: [said], deliver: [] };
      }
      return { ...ended(answer.stopReason === 'refusal' ? 'refused' : 'ok'), append: [said] };
    }

    case 'model_failed': {
      if (turn.phase !== 'model') return refused();
      return ended('failed', event.reason);
    }

    case 'tool_finished': {
      if (turn.phase !== 'tools') return refused();
      const owed = turn.calls.find((call) => call.id === event.call);
      if (owed === undefined || owed.result !== null) return refused();
      const calls = turn.calls.map((call) =>
        call.id === event.call ? { ...call, result: event.result } : call,
      );
      // The result is kept with the turn, not in the conversation yet: the results go in
      // together, in the order the model made the calls.
      return { ...working, turn: { phase: 'tools', calls }, append: [], deliver: [] };
    }

    case 'continue': {
      if (turn.phase !== 'tools') return refused();
      const results = turn.calls.map((call) => call.result);
      if (results.some((result) => result === null)) return refused();
      return {
        ...working,
        turn: { phase: 'model' },
        append: [
          ...results.map((result) => entry(result as ToolResultMessage)),
          ...mail(event.inputs),
        ],
        deliver: event.inputs.map((input) => input.id),
      };
    }
  }
}
