// An MCP server whose tools the agent's scripts can call.

import type { Context, Machine } from './context.ts';

export type McpHeaders = { readonly [name: string]: string };

export type McpServer<TConfig = unknown, TMachine extends Machine | null = Machine | null> = {
  /** The server's MCP endpoint. */
  readonly url: string;
  /**
   * What the server is for, in a line. The model is not told the server's tools ahead: this,
   * with the server's name, is what it has to go on when it looks for one.
   */
  readonly description?: string;
  /**
   * Sent with every request to the server: fixed, or made from the context, which is how a
   * secret gets into one.
   */
  readonly headers?:
    McpHeaders | ((context: Context<TConfig, TMachine>) => McpHeaders | Promise<McpHeaders>);
};
