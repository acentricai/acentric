// The pi agent's step: one message in, the next state out. STEP.md
// describes what it does with every message in every phase.

import type { EffectMessage, Json, JsonObject, Outcome, Step, StepResult } from '@acentric/types';

import { findModel } from './catalog.js';
import type { PiConfig } from './config.js';
import type {
  AssistantMessage,
  ImageBlock,
  TextBlock,
  ThinkingLevel,
  ToolCallBlock,
  ToolResult,
  Usage,
} from './content.js';
import { findCutPoint } from './cut.js';
import { isContextOverflow, isRetryable, retryDelayMs } from './errors.js';
import { isImageBlock, isModelRef, isObject, isThinkingLevel } from './guards.js';
import type { PiKinds } from './kinds.js';
import type { ModelInfo } from './model.js';
import { resolveConfig } from './settings.js';
import type { Aborting, Phase, PiSnapshot, ToolCallState } from './snapshot.js';
import { estimateContext } from './tokens.js';
import { changedPath, prepareToolArguments } from './tools.js';
import { Turn } from './turn.js';

type Content = (TextBlock | ImageBlock)[];
type CallingLlm = Extract<Phase, { kind: 'calling_llm' }>;
type RunningTools = Extract<Phase, { kind: 'running_tools' }>;
type Compacting = Extract<Phase, { kind: 'compacting' }>;

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: 0,
};

export const step: Step<PiSnapshot, PiConfig, PiKinds> = (state, msg, now) => {
  const turn = new Turn(state, now);
  switch (msg.type) {
    case 'input':
      return input(turn, msg.kind, msg.payload);
    case 'effect':
      effect(turn, msg);
      return turn.result();
    case 'config': {
      const resolved = resolveConfig(msg.config);
      if ('error' in resolved) return { error: resolved.error };
      turn.snap.settings = resolved.settings;
      return turn.result();
    }
    case 'migrated':
      return turn.result();
  }
};

// ---- inputs -----------------------------------------------------------------

function input(turn: Turn, kind: string, payload: JsonObject): StepResult<PiSnapshot> {
  const phase = turn.snap.phase;
  switch (kind) {
    case 'prompt':
    case 'steer':
    case 'follow_up': {
      const content = userContent(payload);
      if (typeof content === 'string') return { error: content };
      if (content.some((block) => block.type === 'image') && !model(turn).images) {
        return { error: `${turn.snap.model.id} does not accept images` };
      }
      if (phase.kind === 'idle') {
        startRun(turn, content, kind);
      } else if (kind === 'prompt') {
        return { error: 'busy: a run is going, so send steer or follow_up instead' };
      } else {
        enqueue(turn, content, kind);
      }
      return turn.result();
    }
    case 'abort':
      abort(turn, { next: 'idle' });
      return turn.result();
    case 'compact': {
      const instructions = payload['instructions'];
      if (instructions !== undefined && typeof instructions !== 'string') {
        return { error: 'instructions must be a string' };
      }
      if (phase.kind === 'compacting') return { error: 'already compacting' };
      requestCompaction(turn, instructions ?? null);
      return turn.result();
    }
    case 'set_model': {
      if (!isModelRef(payload)) return { error: 'set_model needs { provider, id }' };
      const ref = { provider: payload.provider, id: payload.id };
      if (!findModel(ref)) return { error: `unknown model ${ref.provider}/${ref.id}` };
      const current = turn.snap.model;
      if (ref.provider !== current.provider || ref.id !== current.id) {
        turn.snap.model = ref;
        turn.append('model_change', { model: ref });
      }
      return turn.result();
    }
    case 'set_thinking': {
      const level = payload['level'];
      if (!isThinkingLevel(level)) return { error: 'level is not a thinking level' };
      if (level !== turn.snap.thinkingLevel) {
        turn.snap.thinkingLevel = level;
        turn.append('thinking_change', { level });
      }
      return turn.result();
    }
    default:
      return { error: `unknown input kind ${kind}` };
  }
}

/** A user message's content, or why the payload is not one. */
function userContent(payload: JsonObject): Content | string {
  const text = payload['text'];
  const images = payload['images'] ?? [];
  if (typeof text !== 'string') return 'text must be a string';
  if (!Array.isArray(images) || !images.every(isImageBlock)) return 'images must be image blocks';
  return [{ type: 'text', text }, ...images];
}

function enqueue(turn: Turn, content: Content, via: 'steer' | 'follow_up'): void {
  const seq = turn.append('queued', { content, via });
  if (via === 'steer') turn.snap.steering = [...turn.snap.steering, seq];
  else turn.snap.followUps = [...turn.snap.followUps, seq];
}

// ---- starting and continuing a run ------------------------------------------

function startRun(turn: Turn, content: Content, via: 'prompt' | 'steer' | 'follow_up'): void {
  turn.append('user', { content, via });
  turn.snap.overflowRecovered = false;
  turn.snap.retries = 0;
  continueRun(turn);
}

/** Calls the model, compacting first if the context is over the threshold. */
function continueRun(turn: Turn): void {
  if (overThreshold(turn) && beginCompaction(turn, 'threshold', true, null)) return;
  callModel(turn);
}

function callModel(turn: Turn): void {
  const info = model(turn);
  const thinkingLevel: ThinkingLevel = info.reasoning ? turn.snap.thinkingLevel : 'off';
  turn.snap.phase = {
    kind: 'calling_llm',
    key: turn.key('llm'),
    model: turn.snap.model,
    thinkingLevel,
    toSeq: turn.nextSeq,
    aborting: null,
  };
}

/** The model stopped without calling tools, or failed for good. */
function endTurn(turn: Turn): void {
  turn.snap.retries = 0;
  if (injectQueued(turn)) {
    continueRun(turn);
  } else if (!(overThreshold(turn) && beginCompaction(turn, 'threshold', false, null))) {
    turn.snap.phase = { kind: 'idle' };
  }
}

/**
 * Injects queued steering, or follow-ups if no steering is queued, as `user`
 * entries. Returns whether anything was injected.
 */
function injectQueued(turn: Turn): boolean {
  return inject(turn, 'steering') || inject(turn, 'followUps');
}

function inject(turn: Turn, queue: 'steering' | 'followUps'): boolean {
  const waiting = turn.snap[queue];
  if (waiting.length === 0) return false;
  const mode =
    queue === 'steering' ? turn.snap.settings.steeringMode : turn.snap.settings.followUpMode;
  const taken = mode === 'all' ? waiting : waiting.slice(0, 1);
  for (const seq of taken) {
    const queued = turn.entry(seq, 'queued');
    if (queued) turn.append('user', { content: queued.body.content, via: queued.body.via });
  }
  turn.snap[queue] = waiting.slice(taken.length);
  return true;
}

// ---- effect results ---------------------------------------------------------

function effect(turn: Turn, msg: EffectMessage<PiKinds>): void {
  const phase = turn.snap.phase;
  switch (msg.kind) {
    case 'llm':
      if (phase.kind === 'calling_llm' && phase.key === msg.key) reply(turn, phase, msg.outcome);
      return;
    case 'read':
    case 'bash':
    case 'edit':
    case 'write':
      if (phase.kind === 'running_tools') toolResult(turn, phase, msg.key, msg.outcome);
      return;
    case 'summarize':
      if (phase.kind === 'compacting' && phase.key === msg.key)
        summarized(turn, phase, msg.outcome);
      return;
    case '@timer':
      if (phase.kind === 'waiting_retry' && phase.key === msg.key) callModel(turn);
      return;
  }
}

function reply(turn: Turn, phase: CallingLlm, outcome: Outcome<AssistantMessage>): void {
  const message = 'ok' in outcome ? outcome.ok : failedReply(phase, outcome);
  const seq = turn.append('assistant', { ...message, thinkingLevel: phase.thinkingLevel });
  const calls = message.content.filter(
    (block): block is ToolCallBlock => block.type === 'toolCall',
  );
  const { compaction, retry } = turn.snap.settings;

  if (phase.aborting !== null || message.stopReason === 'aborted') {
    for (const call of calls) appendToolResult(turn, call, errorResult('Operation aborted'));
    finishAbort(turn, phase.aborting ?? { next: 'idle' });
    return;
  }

  if (
    compaction.enabled &&
    !turn.snap.overflowRecovered &&
    isContextOverflow(message, model(turn).contextWindow)
  ) {
    turn.append('omit', { seq });
    turn.snap.overflowRecovered = true;
    if (beginCompaction(turn, 'overflow', true, null)) return;
    turn.append('notice', {
      level: 'error',
      text: 'The context is too large, and there is nothing to compact.',
    });
    endTurn(turn);
    return;
  }

  if (message.stopReason === 'error') {
    if (retry.enabled && isRetryable(message) && turn.snap.retries < retry.maxRetries) {
      turn.append('omit', { seq });
      turn.snap.retries += 1;
      const delay = retryDelayMs(retry, turn.snap.retries);
      turn.append('notice', {
        level: 'warning',
        text: `Retrying in ${Math.ceil(delay / 1000)}s (attempt ${turn.snap.retries} of ${retry.maxRetries}): ${message.errorMessage ?? 'error'}`,
      });
      turn.snap.phase = { kind: 'waiting_retry', key: turn.key('timer'), at: turn.now + delay };
      return;
    }
    endTurn(turn);
    return;
  }

  turn.snap.retries = 0;
  if (calls.length === 0) {
    endTurn(turn);
  } else if (message.stopReason === 'length') {
    for (const call of calls) {
      appendToolResult(
        turn,
        call,
        errorResult(
          `Tool call ${call.name} was not executed: the response hit the output token limit. Issue the call again, with less output before it.`,
        ),
      );
    }
    afterTools(turn);
  } else {
    startTools(turn, seq, calls);
  }
}

/** The reply step records when the llm effect itself failed rather than returning one. */
function failedReply(phase: CallingLlm, outcome: Exclude<Outcome, { ok: Json }>): AssistantMessage {
  const aborted = 'failed' in outcome && outcome.failed.code === 'aborted';
  return {
    content: [],
    api: '',
    provider: phase.model.provider,
    model: phase.model.id,
    usage: ZERO_USAGE,
    stopReason: aborted ? 'aborted' : 'error',
    errorMessage: failureText(outcome),
  };
}

// ---- tools ------------------------------------------------------------------

function startTools(turn: Turn, assistantSeq: number, blocks: ToolCallBlock[]): void {
  const calls: ToolCallState[] = [];
  for (const block of blocks) {
    const call = { toolCallId: block.id, toolName: block.name };
    const prepared = prepareToolArguments(block);
    if ('error' in prepared) {
      appendToolResult(turn, block, errorResult(prepared.error));
      calls.push({ ...call, status: 'done', key: null, path: null });
      continue;
    }
    const path = changedPath(block.name, prepared.args, turn.snap.settings.cwd);
    const blocked =
      path !== null && calls.some((other) => other.path === path && other.status !== 'done');
    calls.push(
      blocked
        ? { ...call, status: 'waiting', key: null, path }
        : { ...call, status: 'running', key: turn.key(block.name), path },
    );
  }
  if (calls.every((call) => call.status === 'done')) {
    afterTools(turn);
  } else {
    turn.snap.phase = { kind: 'running_tools', assistantSeq, calls, aborting: null };
  }
}

function toolResult(
  turn: Turn,
  phase: RunningTools,
  key: string,
  outcome: Outcome<ToolResult>,
): void {
  const index = phase.calls.findIndex((call) => call.key === key && call.status === 'running');
  const finished = phase.calls[index];
  if (finished === undefined) return;
  const result =
    'ok' in outcome
      ? outcome.ok
      : 'failed' in outcome
        ? errorResult(failureText(outcome))
        : errorResult('Interrupted: the tool call may or may not have run.');
  appendToolResult(turn, { id: finished.toolCallId, name: finished.toolName }, result);

  const calls = phase.calls.map((call, at) =>
    at === index ? { ...call, status: 'done' as const } : call,
  );
  if (phase.aborting === null) startUnblocked(turn, calls);
  if (calls.some((call) => call.status !== 'done')) {
    turn.snap.phase = { ...phase, calls };
  } else if (phase.aborting !== null) {
    finishAbort(turn, phase.aborting);
  } else {
    afterTools(turn);
  }
}

/** Starts waiting edits and writes whose file no earlier unfinished call changes. */
function startUnblocked(turn: Turn, calls: ToolCallState[]): void {
  calls.forEach((call, index) => {
    if (call.status !== 'waiting') return;
    const blocked = calls.some(
      (other, at) => at < index && other.path === call.path && other.status !== 'done',
    );
    if (!blocked) calls[index] = { ...call, status: 'running', key: turn.key(call.toolName) };
  });
}

/** Every tool call of the reply is done: steer, then call the model again. */
function afterTools(turn: Turn): void {
  inject(turn, 'steering');
  continueRun(turn);
}

function appendToolResult(
  turn: Turn,
  call: { id: string; name: string },
  result: ToolResult,
): void {
  turn.append('tool_result', { ...result, toolCallId: call.id, toolName: call.name });
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

// ---- abort ------------------------------------------------------------------

function abort(turn: Turn, aborting: Aborting): void {
  const phase = turn.snap.phase;
  switch (phase.kind) {
    case 'idle':
      if (aborting.next === 'compact') manualCompaction(turn, aborting.instructions);
      return;
    case 'calling_llm':
      if (phase.aborting !== null) {
        if (aborting.next === 'compact') turn.snap.phase = { ...phase, aborting };
        return;
      }
      clearQueues(turn);
      turn.snap.phase = { ...phase, aborting };
      return;
    case 'running_tools': {
      if (phase.aborting !== null) {
        if (aborting.next === 'compact') turn.snap.phase = { ...phase, aborting };
        return;
      }
      clearQueues(turn);
      const calls = phase.calls.map((call) => {
        if (call.status !== 'waiting') return call;
        appendToolResult(
          turn,
          { id: call.toolCallId, name: call.toolName },
          errorResult('Operation aborted'),
        );
        return { ...call, status: 'done' as const };
      });
      if (calls.some((call) => call.status === 'running')) {
        turn.snap.phase = { ...phase, calls, aborting };
      } else {
        finishAbort(turn, aborting);
      }
      return;
    }
    case 'waiting_retry':
    case 'compacting':
      clearQueues(turn);
      finishAbort(turn, aborting);
      return;
  }
}

function finishAbort(turn: Turn, aborting: Aborting): void {
  turn.snap.phase = { kind: 'idle' };
  turn.snap.retries = 0;
  if (aborting.next === 'compact') manualCompaction(turn, aborting.instructions);
}

function clearQueues(turn: Turn): void {
  turn.snap.steering = [];
  turn.snap.followUps = [];
}

// ---- compaction -------------------------------------------------------------

function requestCompaction(turn: Turn, instructions: string | null): void {
  const phase = turn.snap.phase;
  switch (phase.kind) {
    case 'idle':
      manualCompaction(turn, instructions);
      return;
    case 'calling_llm':
    case 'running_tools':
      abort(turn, { next: 'compact', instructions });
      return;
    case 'waiting_retry':
      turn.snap.phase = { kind: 'idle' };
      turn.snap.retries = 0;
      manualCompaction(turn, instructions);
      return;
    case 'compacting':
      return;
  }
}

function manualCompaction(turn: Turn, instructions: string | null): void {
  if (beginCompaction(turn, 'manual', false, instructions)) return;
  turn.append('notice', { level: 'info', text: 'Nothing to compact.' });
  turn.snap.phase = { kind: 'idle' };
}

/** Starts compacting, if there is anything to summarise. */
function beginCompaction(
  turn: Turn,
  reason: Compacting['reason'],
  thenContinue: boolean,
  instructions: string | null,
): boolean {
  const firstKeptSeq = findCutPoint(
    turn.contextEntries(),
    turn.snap.settings.compaction.keepRecentTokens,
  );
  if (firstKeptSeq === null) return false;
  turn.snap.phase = {
    kind: 'compacting',
    key: turn.key('summarize'),
    reason,
    firstKeptSeq,
    tokensBefore: contextTokens(turn),
    instructions,
    thenContinue,
  };
  return true;
}

function summarized(
  turn: Turn,
  phase: Compacting,
  outcome: Outcome<{ summary: string; usage: Usage }>,
): void {
  if (!('ok' in outcome)) {
    turn.append('notice', { level: 'error', text: `Compaction failed: ${failureText(outcome)}` });
    turn.snap.phase = { kind: 'idle' };
    return;
  }
  const seq = turn.append('compaction', {
    summary: outcome.ok.summary,
    firstKeptSeq: phase.firstKeptSeq,
    tokensBefore: phase.tokensBefore,
    usage: outcome.ok.usage,
  });
  turn.snap.compaction = { seq, firstKeptSeq: phase.firstKeptSeq };
  if (phase.thenContinue || injectQueued(turn)) callModel(turn);
  else turn.snap.phase = { kind: 'idle' };
}

// ---- helpers ----------------------------------------------------------------

function model(turn: Turn): ModelInfo {
  const info = findModel(turn.snap.model);
  // Init and set_model accept only models in the catalog.
  if (info === null) throw new Error(`model ${turn.snap.model.id} is not in the catalog`);
  return info;
}

function contextTokens(turn: Turn): number {
  return estimateContext(turn.contextEntries(), turn.summary(), turn.snap.settings.cwd);
}

function overThreshold(turn: Turn): boolean {
  const { enabled, reserveTokens } = turn.snap.settings.compaction;
  return enabled && contextTokens(turn) > model(turn).contextWindow - reserveTokens;
}

/** Readable text for a failed or interrupted outcome. */
function failureText(outcome: Exclude<Outcome, { ok: Json }>): string {
  if (!('failed' in outcome)) return 'interrupted';
  const { code, error } = outcome.failed;
  if (typeof error === 'string') return error;
  if (isObject(error) && typeof error['message'] === 'string') return error['message'];
  return error === null ? code : `${code}: ${JSON.stringify(error)}`;
}
