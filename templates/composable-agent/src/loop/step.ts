// The loop: what step does with every message in every phase, as STEP.md
// says. Each procedure there is one function here. The parts are reached
// only through their own functions, so changing how compaction, retries,
// tools or the agent's own behaviour work does not change this file.

import { llmFailure, pendingToolCalls, toolResult } from '@acentric/llm';
import type { LlmResponse, ToolCall, UserMessage } from '@acentric/llm';
import type { EffectMessage, Outcome, Step } from '@acentric/types';

import * as compaction from '../compaction/index.js';
import type { CompactionPhase, Summary } from '../compaction/index.js';
import * as custom from '../custom/index.js';
import { readInput } from '../inputs/index.js';
import type { Delivery } from '../inputs/index.js';
import { promptArgs } from '../prompt/index.js';
import * as retry from '../retry/index.js';
import * as tools from '../tools/index.js';
import type { CallState, ToolsPhase } from '../tools/index.js';
import type { Config } from '../types/config.js';
import type { Kinds } from '../types/kinds.js';
import { log } from '../types/log.js';
import { readSettings, settingsOf } from '../types/settings.js';
import type { Snapshot } from '../types/snapshot.js';
import { append, appendEntry, closeDraft, newKey, nextSeq, openDraft, update } from './draft.js';
import type { Draft } from './draft.js';
import type { Turn } from './state.js';
import { addUsage } from './usage.js';

/** Model calls in one turn before it is stopped, so a model that never stops calling tools cannot run forever. */
export const MAX_MODEL_CALLS_PER_TURN = 50;

export const step: Step<Snapshot, Config, Kinds> = (state, message, now) => {
  const d = openDraft(state, settingsOf(state.config), now);
  switch (message.type) {
    case 'input': {
      const rejected = input(d, message.kind, message.payload);
      if (rejected !== null) return rejected;
      break;
    }
    case 'config': {
      const read = readSettings(message.config);
      if ('error' in read) return read;
      break;
    }
    case 'effect':
      effect(d, message);
      break;
    case 'migrated':
      break;
  }
  return closeDraft(d);
};

// ---- inputs ----------------------------------------------------------------

/** Acts on a caller's input, or says why it is refused. */
function input(d: Draft, kind: string, payload: unknown): { error: string } | null {
  const read = readInput(kind, payload);
  if ('error' in read) return read;
  const { input: checked } = read;
  if (checked.role === 'message') {
    onMessage(d, checked.message, checked.delivery);
    return null;
  }
  switch (checked.kind) {
    case 'interrupt':
      interrupt(d);
      return null;
    // An agent's own control inputs are acted on here.
    default:
      return { error: `the ${checked.kind} input is not handled` };
  }
}

/** A message starts a turn when idle; otherwise it waits to steer this turn or start the next. */
function onMessage(d: Draft, user: UserMessage, delivery: Delivery | undefined): void {
  if (d.snapshot.phase.type === 'idle') {
    startTurn(d, [user]);
    return;
  }
  const seq = append(d, 'queued', user);
  // With no turn, as while compacting after one, there is nothing to steer.
  const steer =
    d.snapshot.turn !== null && (delivery ?? d.settings.inputs.defaultDelivery) === 'steer';
  update(
    d,
    steer ? { steering: [...d.snapshot.steering, seq] } : { queued: [...d.snapshot.queued, seq] },
  );
}

/** Stops the turn in progress, dropping the messages waiting for one. */
function interrupt(d: Draft): void {
  const dropped = d.snapshot.steering.length + d.snapshot.queued.length;
  update(d, { steering: [], queued: [] });
  if (dropped > 0) {
    append(d, 'notice', {
      level: 'info',
      text: `the interrupt dropped ${dropped} waiting message(s)`,
    });
  }
  const { turn, phase } = d.snapshot;
  if (turn === null || turn.stopping) return;
  update(d, { turn: { ...turn, stopping: true } });
  // A model call and tool calls are aborted by `effects` and end the turn
  // when they report; a summary finishes, since the session needs it.
  if (phase.type === 'waiting_retry') endTurn(d);
}

// ---- effects ---------------------------------------------------------------

/** An effect reported: taken only when its key is one the phase, or the custom part, is waiting on. */
function effect(d: Draft, reported: EffectMessage<Kinds>): void {
  if (custom.ownsKey(reported.key)) {
    const done = custom.onEffect(d.snapshot, reported.key, reported.outcome, d.now, d.settings);
    update(d, done.state);
    for (const entry of done.append) appendEntry(d, entry);
    return;
  }
  const { phase } = d.snapshot;
  if (phase.type === 'calling_model' && reported.kind === 'llm' && reported.key === phase.key) {
    reply(d, reported.outcome);
  } else if (phase.type === 'running_tools') {
    const call = phase.calls.find((c) => c.key === reported.key && c.status === 'running');
    if (call !== undefined) toolDone(d, phase, call, reported.outcome);
  } else if (phase.type === 'waiting_retry' && reported.key === phase.key) {
    callModel(d);
  } else if (
    phase.type === 'compacting' &&
    reported.kind === 'summarize' &&
    reported.key === phase.key
  ) {
    summary(d, phase, reported.outcome);
  }
}

// ---- turns -----------------------------------------------------------------

function startTurn(d: Draft, messages: readonly UserMessage[]): void {
  // A part's hook gets the snapshot as its own part and returns it changed,
  // with every other field as it was: apply what it returns on its own,
  // before the loop changes fields of its own.
  update(d, custom.onTurnStart(d.snapshot, d.now));
  update(d, {
    turn: { startedAt: d.now, modelCalls: 0, stopping: false },
    ...retry.reset(),
    ...compaction.atTurnStart(),
  });
  for (const user of messages) append(d, 'user', user);
  continueTurn(d);
}

/** Compacts first if the compaction part says to, and otherwise calls the model. */
function continueTurn(d: Draft): void {
  if (
    compaction.shouldCompact(d.snapshot, d.entries, d.settings) &&
    startCompacting(d, 'threshold', true)
  ) {
    return;
  }
  callModel(d);
}

function callModel(d: Draft): void {
  // The one place steering messages reach the model: at its next call.
  for (const seq of d.snapshot.steering) append(d, 'user', waiting(d, seq));
  update(d, { steering: [] });
  const turn = turnOf(d);
  if (turn.modelCalls >= MAX_MODEL_CALLS_PER_TURN) {
    append(d, 'notice', {
      level: 'warning',
      text: `the turn was stopped after ${MAX_MODEL_CALLS_PER_TURN} model calls`,
    });
    endTurn(d);
    return;
  }
  const key = newKey(d, 'llm');
  update(d, {
    turn: { ...turn, modelCalls: turn.modelCalls + 1 },
    phase: {
      type: 'calling_model',
      key,
      args: {
        model: d.settings.model,
        thinking: d.settings.thinking,
        context: compaction.contextRefs(d.snapshot, nextSeq(d)),
        prompt: promptArgs(d.settings),
        tools: tools.toolNames(),
      },
    },
  });
}

function endTurn(d: Draft): void {
  const { steering, queued, turn } = d.snapshot;
  if (steering.length > 0 && turn !== null && !turn.stopping) {
    continueTurn(d);
    return;
  }
  // Steering messages are only waiting here if they arrived after an
  // interrupt: they start a fresh turn rather than continue a stopped one.
  const messages = [...steering, ...queued].map((seq) => waiting(d, seq));
  if (messages.length > 0) {
    update(d, { steering: [], queued: [] });
    startTurn(d, messages);
    return;
  }
  update(d, { turn: null });
  if (
    compaction.shouldCompact(d.snapshot, d.entries, d.settings) &&
    startCompacting(d, 'threshold', false)
  ) {
    return;
  }
  update(d, custom.onIdle(d.snapshot, d.now, d.settings));
  update(d, { phase: { type: 'idle' } });
}

// ---- the model's reply -----------------------------------------------------

function reply(d: Draft, outcome: Outcome<LlmResponse>): void {
  if ('ok' in outcome) replied(d, outcome.ok);
  else failed(d, outcome);
}

function replied(d: Draft, response: LlmResponse): void {
  const replySeq = append(d, 'assistant', response);
  update(d, { totals: addUsage(d.snapshot.totals, response.usage), ...retry.reset() });
  // Calls of provider-defined tools (computer use, shell) are answered
  // differently, and the template has none.
  const calls = pendingToolCalls(response.message).filter((call) => call.toolType !== 'native');
  if (turnOf(d).stopping) {
    answer(d, calls, 'the turn was interrupted');
    endTurn(d);
  } else if (calls.length > 0 && response.stopReason === 'length') {
    answer(d, calls, 'the reply was cut off before the call was complete');
    continueTurn(d);
  } else if (calls.length > 0) {
    startTools(d, replySeq, calls);
  } else if (response.stopReason === 'pause_turn') {
    callModel(d);
  } else {
    endTurn(d);
  }
}

function failed(d: Draft, outcome: Exclude<Outcome<LlmResponse>, { ok: unknown }>): void {
  if (turnOf(d).stopping) {
    endTurn(d);
    return;
  }
  const failure = llmFailure(outcome);
  const code = 'failed' in outcome ? outcome.failed.code : 'interrupted';
  const text = failure?.message ?? `the model call failed: ${code}`;
  if (
    failure?.kind === 'context_overflow' &&
    compaction.compactOnOverflow(d.snapshot) &&
    startCompacting(d, 'overflow', true)
  ) {
    update(d, compaction.overflowCompacting());
    append(d, 'model_error', { failure, text, retrying: true });
    return;
  }
  if (retry.shouldRetry(failure, code, d.snapshot, d.settings)) {
    const retries = retry.failedOnce(d.snapshot);
    const at = retry.retryAt(d.now, retries, failure, d.settings);
    update(d, { ...retries, phase: { type: 'waiting_retry', key: newKey(d, 'timer'), at } });
    append(d, 'model_error', { failure, text, retrying: true });
    return;
  }
  append(d, 'model_error', { failure, text, retrying: false });
  endTurn(d);
}

// ---- tools -----------------------------------------------------------------

function startTools(d: Draft, replySeq: number, calls: readonly ToolCall[]): void {
  const started = tools.startCalls(calls, toolContext(d));
  update(d, started.state);
  for (const { call, output } of started.answers) appendResult(d, call, output);
  const keyed: CallState[] = [];
  for (const call of started.waiting) keyed.push({ ...call, key: newKey(d, 'tool') });
  const scheduled = tools.schedule(keyed, calls, false);
  if (scheduled.length === 0) {
    continueTurn(d);
    return;
  }
  update(d, { phase: { type: 'running_tools', replySeq, calls: scheduled } });
}

function toolDone(d: Draft, phase: ToolsPhase, call: CallState, outcome: Outcome): void {
  const replyCalls = replyCallsOf(d, phase.replySeq);
  const settled = tools.settleCall(
    call,
    callNamed(replyCalls, call.callId),
    outcome,
    toolContext(d),
  );
  update(d, settled.state);
  appendResult(d, callNamed(replyCalls, call.callId), settled.output);
  const done = phase.calls.map((c): CallState =>
    c.key === call.key ? { ...c, status: 'done' } : c,
  );
  const { stopping } = turnOf(d);
  const calls = tools.schedule(done, replyCalls, stopping);
  if (calls.some((c) => c.status === 'running')) {
    update(d, { phase: { ...phase, calls } });
    return;
  }
  if (stopping) {
    const never = calls.filter((c) => c.status === 'waiting');
    answer(
      d,
      never.map((c) => callNamed(replyCalls, c.callId)),
      'the turn was interrupted',
    );
    endTurn(d);
    return;
  }
  continueTurn(d);
}

/** Answers calls that will not run, saying why. */
function answer(d: Draft, calls: readonly ToolCall[], why: string): void {
  for (const call of calls) appendResult(d, call, tools.notRun(call.toolName, why));
}

function appendResult(d: Draft, call: ToolCall, output: tools.ToolOutput): void {
  append(
    d,
    'tool_result',
    toolResult(call, output.content, output.isError === true ? { isError: true } : {}),
  );
}

function toolContext(d: Draft): tools.ToolContext {
  return { settings: d.settings, state: d.snapshot, now: d.now };
}

function replyCallsOf(d: Draft, replySeq: number): ToolCall[] {
  const entry = log.entryAt(d.entries, replySeq, 'assistant');
  if (entry === null) throw new Error(`the reply at ${replySeq} is not in the window`);
  return pendingToolCalls(entry.body.message);
}

function callNamed(calls: readonly ToolCall[], callId: string): ToolCall {
  const call = calls.find((c) => c.toolCallId === callId);
  if (call === undefined) throw new Error(`the reply has no call ${callId}`);
  return call;
}

// ---- compaction ------------------------------------------------------------

/** Starts compacting, if there is anything to summarise. */
function startCompacting(
  d: Draft,
  reason: CompactionPhase['reason'],
  thenContinue: boolean,
): boolean {
  const plan = compaction.planCompaction(d.snapshot, d.entries, d.settings);
  if (plan === null) return false;
  update(d, {
    phase: { type: 'compacting', key: newKey(d, 'summarize'), reason, thenContinue, ...plan },
  });
  return true;
}

function summary(d: Draft, phase: CompactionPhase, outcome: Outcome<Summary>): void {
  const { turn } = d.snapshot;
  const goOn = phase.thenContinue && turn !== null && !turn.stopping;
  if ('ok' in outcome) {
    const seq = append(d, 'compaction', compaction.compactionEntry(phase, outcome.ok, d.settings));
    update(d, {
      ...compaction.compacted(phase, seq),
      totals: addUsage(d.snapshot.totals, outcome.ok.usage),
    });
    if (goOn) callModel(d);
    else endTurn(d);
    return;
  }
  const why = 'failed' in outcome ? outcome.failed.code : 'interrupted';
  append(d, 'notice', { level: 'warning', text: `compaction failed: ${why}` });
  // The context still fits after a threshold compaction fails; not after an overflow.
  if (goOn && phase.reason === 'threshold') {
    callModel(d);
    return;
  }
  if (goOn) {
    append(d, 'model_error', {
      failure: null,
      text: 'the context is too large for the model, and compacting it failed',
      retrying: false,
    });
  }
  endTurn(d);
}

// ---- reading the draft -----------------------------------------------------

function turnOf(d: Draft): Turn {
  const { turn } = d.snapshot;
  if (turn === null) throw new Error('no turn is going');
  return turn;
}

/** The user message a waiting message's `queued` entry holds. */
function waiting(d: Draft, seq: number): UserMessage {
  const entry = log.entryAt(d.entries, seq, 'queued');
  if (entry === null) throw new Error(`the waiting message at ${seq} is not in the window`);
  return entry.body;
}
