// The pi agent's effects: what each kind takes and returns.
//
// Args reference data rather than copy it. The conversation and the tools'
// arguments are already in the log, so the model call gets the range of log
// entries to read, and a tool gets the log entry and id of the tool call it
// runs. Copying them would grow with every turn and duplicate the log.
//
// Every effect that touches files gets the agent's working directory, so a
// handler depends only on its args and the log.

import type { AssistantMessage, ModelRef, ThinkingLevel, ToolResult, Usage } from './content.js';

/**
 * A model call. The context is the system prompt, then the summary in the
 * compaction entry at `compactionSeq` if there is one, then the
 * conversation entries in [fromSeq, toSeq). Building it is a pure function
 * shared with step.
 */
export type LlmArgs = {
  model: ModelRef;
  thinkingLevel: ThinkingLevel;
  cwd: string;
  compactionSeq: number | null;
  fromSeq: number;
  toSeq: number;
};

/** One tool call to run: the log entry of the assistant message that made it, and its id. */
export type ToolCallRef = {
  seq: number;
  toolCallId: string;
  cwd: string;
};

/** A summary of the log entries in [fromSeq, toSeq), extending an earlier summary if given. */
export type SummarizeArgs = {
  model: ModelRef;
  fromSeq: number;
  toSeq: number;
  /** The compaction entry holding the previous summary, or null for the first. */
  previousSummarySeq: number | null;
  instructions: string | null;
};

export type Summary = {
  summary: string;
  usage: Usage;
};

export type PiKinds = {
  /** Calls the model. Reissue. */
  llm: { args: LlmArgs; result: AssistantMessage };
  /** Reads a file or image. Reissue. */
  read: { args: ToolCallRef; result: ToolResult };
  /** Runs a shell command. Once. */
  bash: { args: ToolCallRef; result: ToolResult };
  /** Replaces exact text in a file. Once. */
  edit: { args: ToolCallRef; result: ToolResult };
  /** Creates or overwrites a file. Reissue, since writing twice is the same as once. */
  write: { args: ToolCallRef; result: ToolResult };
  /** Summarises older history for compaction. Reissue. */
  summarize: { args: SummarizeArgs; result: Summary };
  /** The runner's timer, used to wait before retrying a failed model call. */
  '@timer': { args: { at: number }; result: null };
};
