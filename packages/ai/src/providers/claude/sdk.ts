// What of the Claude Agent SDK the provider uses, as it is used. The SDK is not a dependency of
// this package: the server installs it only when it is started with Claude, and hands its
// module over (see `claudeProvider`). So its types are written here, as narrow as the use.

/** A message of the user's, as the SDK reads its input. */
export type SdkUserMessage = {
  readonly type: 'user';
  readonly message: { readonly role: 'user'; readonly content: readonly unknown[] };
  readonly parent_tool_use_id: null;
  /** Sent while tools run: heard after their results, before the model is called again. */
  readonly priority?: 'next';
};

/** One of the events a session gives. Only the fields read here are typed. */
export type SdkMessage = { readonly type: string; readonly [field: string]: unknown };

/** A session under way: its events, until its process ends. */
export interface SdkQuery extends AsyncIterable<SdkMessage> {
  /** Stops the turn the session is in. */
  interrupt(): Promise<void>;
}

/** Where a session's transcript is kept, as the SDK names it. */
export type SessionKey = {
  readonly projectKey: string;
  readonly sessionId: string;
  readonly subpath?: string;
};

/** One line of a session's transcript: Claude Code's own format, which the SDK does not document. */
export type TranscriptEntry = { readonly [field: string]: unknown };

/** What keeps a session's transcript, for the SDK to resume it from. */
export type SdkSessionStore = {
  append(key: SessionKey, entries: TranscriptEntry[]): Promise<void>;
  load(key: SessionKey): Promise<TranscriptEntry[] | null>;
  listSubkeys(key: { readonly projectKey: string; readonly sessionId: string }): Promise<string[]>;
};

/** The SDK's `query`. Its options are many: those given are written where it is called. */
export type SdkQueryFunction = (params: {
  readonly prompt: AsyncIterable<SdkUserMessage>;
  readonly options: { readonly [option: string]: unknown };
}) => SdkQuery;

/** The SDK's module, as the provider uses it. */
export type ClaudeSdk = { readonly query: SdkQueryFunction };

/** What a tool's handler gives back: MCP's tool result. */
export type ToolResult = {
  readonly content: readonly (
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'image'; readonly data: string; readonly mimeType: string }
  )[];
  readonly isError?: true;
};
