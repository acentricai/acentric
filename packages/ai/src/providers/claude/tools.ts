// The engine's tools, as a server of MCP's in the provider's own process, which a session is
// given in place of Claude Code's tools. A tool is listed with its schema exactly as the engine
// has it, and a call of it is handed to whoever waits for it: the engine runs it its own way,
// and its result comes back with the next step.
//
// The SDK runs a server like this one by calling `connect` with a transport over its control
// channel, as it does a server of MCP's own SDK; only the few requests a client makes of a
// server of tools are answered here.

import type { FunctionTool, JsonObject } from '@acentric/protocol';

import type { ToolResult } from './sdk.ts';

/** A message of JSON-RPC's, as the transport carries it. */
type RpcMessage = {
  readonly jsonrpc?: '2.0';
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: { readonly [field: string]: unknown };
};

/** The transport the SDK gives a server: the shape of MCP's own. */
export type Transport = {
  onmessage?: (message: RpcMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  start(): Promise<void>;
  send(message: JsonObject): Promise<void>;
  close(): Promise<void>;
};

/** Where a call goes: its tool, what it was called with, and the ID of the model's call. */
export type CallHandler = (call: {
  readonly name: string;
  readonly toolUseId: string | undefined;
}) => Promise<ToolResult>;

/** Asks Claude Code to list a tool from the start, not to keep it behind its tool search. */
const ALWAYS_LOAD = 'anthropic/alwaysLoad';
/** How long a result may be before Claude Code puts it in a file, which the model has no tool to read. */
const MOST_RESULT = 'anthropic/maxResultSizeChars';
/** Where Claude Code says which call of the model's a call is. */
const TOOL_USE_ID = 'claudecode/toolUseId';

/** The engine's tools, served to one session. */
export class ToolServer {
  readonly #name: string;
  readonly #tools: readonly FunctionTool[];
  readonly #call: CallHandler;

  constructor(name: string, tools: readonly FunctionTool[], call: CallHandler) {
    this.#name = name;
    this.#tools = tools;
    this.#call = call;
  }

  /** What a session is given in `mcpServers`. */
  config(): JsonObject {
    return { type: 'sdk', name: this.#name, instance: this as never };
  }

  async connect(transport: Transport): Promise<void> {
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP's transport is given its handler so.
    transport.onmessage = (message) => {
      void this.#answer(message).then(
        (reply) => (reply === undefined ? undefined : transport.send(reply)),
        () => undefined,
      );
    };
    await transport.start();
  }

  async close(): Promise<void> {
    // Nothing is held: the session's process holds the other end.
  }

  /** The reply to a request, or undefined for a notification. */
  async #answer(message: RpcMessage): Promise<JsonObject | undefined> {
    const { id, method, params } = message;
    if (id === undefined) return undefined;
    const reply = (result: JsonObject): JsonObject => ({ jsonrpc: '2.0', id, result });
    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion:
            typeof params?.['protocolVersion'] === 'string'
              ? params['protocolVersion']
              : '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: this.#name, version: '1.0.0' },
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({
          tools: this.#tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters,
            // Every call of an answer is handed over at once: the engine decides how they run.
            annotations: { readOnlyHint: true },
            _meta: { [ALWAYS_LOAD]: true, [MOST_RESULT]: 2_000_000 },
          })),
        });
      case 'tools/call': {
        const name = typeof params?.['name'] === 'string' ? params['name'] : '';
        const meta = params?.['_meta'] as { readonly [field: string]: unknown } | undefined;
        const toolUseId = typeof meta?.[TOOL_USE_ID] === 'string' ? meta[TOOL_USE_ID] : undefined;
        const result = await this.#call({ name, toolUseId });
        return reply(result as unknown as JsonObject);
      }
      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `No method ${method ?? ''}` },
        };
    }
  }
}
