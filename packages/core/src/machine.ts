// The turn machine: given where an actor stands and something that happened, what is stored.
//
// It reads no clock, calls nothing and waits for nothing, so every case of it is tested with
// no store, no model and no agent. It gives the change and no list of things to do: what is to
// be done next is read off the state the change stores (see `Turn`).

import type { ModelAnswer } from '@acentric/ai';
import type {
  ConversationEntry,
  Input,
  Message,
  ToolResultMessage,
  TurnEnd,
} from '@acentric/protocol';

import type { ActorPatch, ActorRecord, Change, OwedCall, Turn } from './state.ts';

/** How a call of the model that failed is made again. */
export type RetryPolicy = {
  /** How many times a call is made, the first included. */
  readonly maxAttempts: number;
  /** The wait before the second try, in milliseconds. Each later one waits `factor` times longer. */
  readonly initialDelayMs: number;
  readonly factor: number;
  /** The longest wait between two tries. */
  readonly maxDelayMs: number;
};

export type Rules = {
  readonly retry: RetryPolicy;
  /**
   * How many times a restart may find the same call of the model owed before the turn fails.
   * It keeps a call that takes the process down with it from being made for ever.
   */
  readonly maxCutOffs: number;
};

export const DEFAULT_RULES: Rules = {
  retry: { maxAttempts: 4, initialDelayMs: 1000, factor: 2, maxDelayMs: 30_000 },
  maxCutOffs: 5,
};

export type MachineEvent =
  /**
   * The actor is idle and has mail: a turn starts with it. `set` moves the actor to another
   * deployment of its agent as the turn starts, or says why it could not move.
   */
  | { readonly type: 'wake'; readonly inputs: readonly Input[]; readonly set?: ActorPatch }
  /** A person asks that a turn that failed be tried again, with nothing new. */
  | { readonly type: 'retry'; readonly set?: ActorPatch }
  /** A person changes what the actor was created with. Only between turns. */
  | { readonly type: 'update'; readonly set: ActorPatch }
  /**
   * The model answered. `sent` names the instructions and tools the call was made with, and
   * the place its reasoning was sent from.
   */
  | {
      readonly type: 'answered';
      readonly answer: ModelAnswer;
      readonly sent?: NonNullable<Change['sent']>;
    }
  /** The call of the model failed. */
  | {
      readonly type: 'model_failed';
      readonly reason: string;
      /** Whether the same call may work later. */
      readonly retryable: boolean;
      /** How long the provider said to wait, when it said. */
      readonly retryAfterMs?: number;
      /**
       * The provider refused the conversation for reasoning tied to what has since changed.
       * The call is made again at once without the reasoning there is so far.
       */
      readonly staleReasoning?: boolean;
    }
  /** A restart found the call of the model owed: it may have been under way. */
  | { readonly type: 'cut_off' }
  /**
   * One of the tool calls that are owed was answered. `inputs` is the mail at that moment:
   * when this is the last result, the turn goes back to the model with it, in the same step.
   */
  | {
      readonly type: 'tool_finished';
      readonly call: string;
      readonly result: ToolResultMessage;
      readonly inputs: readonly Input[];
    }
  /** A person ended the turn. */
  | { readonly type: 'interrupted' }
  | { readonly type: 'archive' }
  | { readonly type: 'unarchive' };

/** The event does not follow from where the actor stands. */
export class OutOfTurn extends Error {
  override readonly name = 'OutOfTurn';
}

/** What a tool call the turn ended before is answered with. */
function stopped(call: OwedCall): ToolResultMessage {
  return {
    role: 'tool_result',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text: 'The call was stopped: the turn was interrupted.' }],
    isError: true,
  };
}

/** The first call of the model of a turn, or the next after tools. */
function model(startSeq: number): Turn {
  return { phase: 'model', startSeq, attempt: 1, cutOffs: 0, retryAt: null };
}

export function decide(
  record: ActorRecord,
  event: MachineEvent,
  now: number,
  rules: Rules = DEFAULT_RULES,
): Change {
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
  const refuse = (): never => {
    throw new OutOfTurn(`${event.type} does not follow from ${actor.status}, ${turn.phase}`);
  };

  /** A step of a turn that goes on. */
  const goesOn = (
    next: Turn,
    append: readonly ConversationEntry[] = [],
    inputs: readonly Input[] = [],
  ): Change => ({
    at: now,
    status: 'working',
    lastTurn: actor.lastTurn,
    archivedAt: actor.archivedAt,
    turn: next,
    append,
    deliver: inputs.map((input) => input.id),
    leaveOutFrom: null,
    set: null,
    sent: null,
  });
  /** The step that ends a turn. */
  const ends = (
    end: TurnEnd['end'],
    reason?: string,
    append: readonly ConversationEntry[] = [],
  ): Change => ({
    at: now,
    status: 'idle',
    lastTurn: { end, at: now, ...(reason === undefined ? {} : { reason }) },
    archivedAt: actor.archivedAt,
    turn: { phase: 'idle' },
    append,
    deliver: [],
    leaveOutFrom: null,
    set: null,
    sent: null,
  });
  switch (event.type) {
    case 'wake': {
      if (actor.status !== 'idle' || turn.phase !== 'idle' || event.inputs.length === 0) {
        return refuse();
      }
      return {
        ...goesOn(model(record.nextSeq), mail(event.inputs), event.inputs),
        set: event.set ?? null,
      };
    }

    case 'retry': {
      if (actor.status !== 'idle' || turn.phase !== 'idle' || actor.lastTurn?.end !== 'failed') {
        return refuse();
      }
      return { ...goesOn(model(record.nextSeq)), set: event.set ?? null };
    }

    case 'update': {
      if (actor.status === 'working' || turn.phase !== 'idle') return refuse();
      return {
        ...ends('ok'),
        status: actor.status,
        lastTurn: actor.lastTurn,
        set: event.set,
      };
    }

    case 'answered': {
      if (turn.phase !== 'model') return refuse();
      const { answer } = event;
      const sent = event.sent ?? null;
      const completion = {
        stopReason: answer.stopReason,
        ...(answer.usage === undefined ? {} : { usage: answer.usage }),
      };
      if (answer.stopReason === 'refusal') {
        // What the model declined is kept, and never sent to it again: neither its refusal nor
        // what the turn had given it.
        return {
          ...ends('refused', 'The model declined', [
            entry(answer.message, { completion, leftOut: true }),
          ]),
          leaveOutFrom: turn.startSeq,
          sent,
        };
      }
      const said = entry(answer.message, { completion });
      if (answer.toolCalls.length === 0) {
        // The provider paused in the middle of its own work: sent its answer back, it goes on.
        if (answer.stopReason === 'pause_turn') {
          return { ...goesOn(model(turn.startSeq), [said]), sent };
        }
        return { ...ends('ok', undefined, [said]), sent };
      }
      const calls: OwedCall[] = answer.toolCalls.map((call) => ({ ...call, result: null }));
      return { ...goesOn({ phase: 'tools', startSeq: turn.startSeq, calls }, [said]), sent };
    }

    case 'model_failed': {
      if (turn.phase !== 'model') return refuse();
      const { retry } = rules;
      const again = event.retryable || event.staleReasoning === true;
      if (!again || turn.attempt >= retry.maxAttempts) return ends('failed', event.reason);
      if (event.staleReasoning === true) {
        // Not a wait for the provider: the same call, without the reasoning that was refused.
        return {
          ...goesOn({ ...turn, attempt: turn.attempt + 1, retryAt: null }),
          sent: { fingerprint: record.sent, reasoningFrom: record.nextSeq },
        };
      }
      const backoff = Math.min(
        retry.initialDelayMs * retry.factor ** (turn.attempt - 1),
        retry.maxDelayMs,
      );
      const wait = event.retryAfterMs ?? backoff;
      return goesOn({ ...turn, attempt: turn.attempt + 1, retryAt: now + wait });
    }

    case 'cut_off': {
      if (turn.phase !== 'model') return refuse();
      if (turn.cutOffs >= rules.maxCutOffs) {
        const times = String(turn.cutOffs + 1);
        return ends('failed', `The call of the model was cut off by a restart ${times} times`);
      }
      return goesOn({ ...turn, cutOffs: turn.cutOffs + 1 });
    }

    case 'tool_finished': {
      if (turn.phase !== 'tools') return refuse();
      const owed = turn.calls.find((call) => call.id === event.call);
      if (owed === undefined || owed.result !== null) return refuse();
      const calls = turn.calls.map((call) =>
        call.id === event.call ? { ...call, result: event.result } : call,
      );
      const results = calls.map((call) => call.result);
      if (results.includes(null)) {
        // Kept with the turn, not in the conversation yet: the results go in together, in the
        // order the model made the calls.
        return goesOn({ phase: 'tools', startSeq: turn.startSeq, calls });
      }
      // The last one: the results, the mail that came meanwhile, and back to the model.
      return goesOn(
        model(turn.startSeq),
        [...results.map((result) => entry(result as ToolResultMessage)), ...mail(event.inputs)],
        event.inputs,
      );
    }

    case 'interrupted': {
      if (turn.phase === 'idle') return refuse();
      if (turn.phase === 'model') return ends('interrupted');
      // Every call the model made has an answer in the conversation, or the next call of the
      // model is refused: those that were stopped say so.
      return ends(
        'interrupted',
        undefined,
        turn.calls.map((call) => entry(call.result ?? stopped(call))),
      );
    }

    case 'archive': {
      if (actor.status !== 'idle' || turn.phase !== 'idle') return refuse();
      return { ...ends('ok'), status: 'archived', lastTurn: actor.lastTurn, archivedAt: now };
    }

    case 'unarchive': {
      if (actor.status !== 'archived') return refuse();
      return { ...ends('ok'), lastTurn: actor.lastTurn, archivedAt: null };
    }
  }
}
