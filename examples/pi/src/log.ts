// The pi agent's log entries: the body of each kind.
//
// The log is the agent's history, and it is where everything large goes:
// it is written once, while the snapshot is rewritten on every step. What
// the model sees is built from it by a pure projection, which includes
// `user`, `assistant` and `tool_result` entries and the latest compaction's
// summary, drops entries named by `omit`, and skips every other kind.

import type {
  AssistantMessage,
  ImageBlock,
  ModelRef,
  TextBlock,
  ThinkingLevel,
  ToolResult,
  Usage,
} from './content.js';

export type PiLog = {
  /** A user message the model sees, and how it arrived. */
  user: {
    content: (TextBlock | ImageBlock)[];
    via: 'prompt' | 'steer' | 'follow_up';
  };
  /**
   * A steer or follow-up message waiting for its turn. The model does not
   * see it here; when its turn comes, step appends it again as a `user`
   * entry, where the conversation is at that point.
   */
  queued: {
    content: (TextBlock | ImageBlock)[];
    via: 'steer' | 'follow_up';
  };
  /** A model reply, including failed and aborted ones, and the thinking level it used. */
  assistant: AssistantMessage & { thinkingLevel: ThinkingLevel };
  /** One tool call's result. */
  tool_result: ToolResult & { toolCallId: string; toolName: string };
  model_change: { model: ModelRef };
  thinking_change: { level: ThinkingLevel };
  /** Older history replaced by a summary. The model sees the summary, then the entries from `firstKeptSeq`. */
  compaction: {
    summary: string;
    firstKeptSeq: number;
    /** The estimated context size before compacting. */
    tokensBefore: number;
    usage: Usage;
  };
  /** Leaves the entry at `seq` out of what the model sees, such as a failed attempt before a retry. */
  omit: { seq: number };
  /** Something for callers and UIs to show, such as a retry or a failed compaction. */
  notice: { level: 'info' | 'warning' | 'error'; text: string };
};

export type PiLogKind = keyof PiLog;
