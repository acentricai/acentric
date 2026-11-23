// The MCP servers of an agent, as the engine reaches them: over HTTP, with the headers the
// agent gives, which is how a secret gets to one.
//
// No connection is kept. An engine has many actors, most of them idle, each with headers of
// its own, so every use connects, does one thing and closes. What a server offers is asked for
// when a script is about to start, and kept for a while for that actor.

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import type { Actor, Json, McpServerDeclaration } from '@acentric/protocol';

import type { CallResult } from './executor.ts';
import { issuesText } from './executor.ts';

/** A tool of a server, as the server lists it. */
export type McpTool = {
  readonly server: string;
  /** The server's own name for it. */
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: Json;
  readonly outputSchema?: Json;
  /** The server says it only reads, or that doing it twice is doing it once: it can be called again. */
  readonly retrySafe: boolean;
};

/** What a server answered a call with. */
export type McpResult = {
  readonly content: readonly {
    readonly type: string;
    readonly text?: string;
    readonly [key: string]: unknown;
  }[];
  readonly structuredContent?: Json;
  readonly isError?: boolean;
};

/** What an actor's servers offer, and which of them could not be asked. */
export type McpCatalog = {
  readonly tools: readonly McpTool[];
  readonly down: readonly { readonly server: string; readonly reason: string }[];
};

export type McpOptions = {
  /** Calls a function of the code an actor is on: a server's headers are made by it. */
  readonly call: (actor: Actor, path: string, argument: Json) => Promise<CallResult>;
  /** The fetch servers are reached with, in place of the global one. */
  readonly fetch?: typeof fetch;
  /** How long a server has to answer a connection or a list, in milliseconds. */
  readonly timeoutMs?: number;
  /** How long what an actor's servers offer is kept before it is asked for again. */
  readonly cacheMs?: number;
  readonly clock?: () => number;
};

/** The longest a timer is set for: what one can hold. */
const LONGEST_TIMER_MS = 2_000_000_000;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class Mcp {
  readonly #call: McpOptions['call'];
  readonly #fetch: typeof fetch | undefined;
  readonly #timeoutMs: number;
  readonly #cacheMs: number;
  readonly #clock: () => number;
  readonly #catalogs = new Map<string, { readonly at: number; readonly catalog: McpCatalog }>();

  constructor(options: McpOptions) {
    this.#call = options.call;
    this.#fetch = options.fetch;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#cacheMs = options.cacheMs ?? 600_000;
    this.#clock = options.clock ?? Date.now;
  }

  /**
   * What an actor's servers offer. A server that cannot be asked offers nothing, and is named
   * in `down` with why: one server that is away does not take the others with it.
   */
  async catalog(actor: Actor, servers: readonly McpServerDeclaration[]): Promise<McpCatalog> {
    if (servers.length === 0) return { tools: [], down: [] };
    // Of the code the actor is on: other code may have other servers.
    const key = `${actor.deployment.id}/${actor.id}`;
    const kept = this.#catalogs.get(key);
    if (kept !== undefined && this.#clock() - kept.at < this.#cacheMs) return kept.catalog;

    const listed = await Promise.all(
      servers.map(async (server) => {
        try {
          const tools = await this.#with(actor, server, undefined, async (client) => {
            const all: McpTool[] = [];
            let cursor: string | undefined;
            do {
              const page = await client.listTools(cursor === undefined ? undefined : { cursor }, {
                timeout: this.#timeoutMs,
              });
              for (const tool of page.tools) {
                all.push({
                  server: server.name,
                  name: tool.name,
                  description: tool.description ?? tool.title ?? '',
                  inputSchema: tool.inputSchema as Json,
                  ...(tool.outputSchema === undefined
                    ? {}
                    : { outputSchema: tool.outputSchema as Json }),
                  retrySafe:
                    tool.annotations?.readOnlyHint === true ||
                    tool.annotations?.idempotentHint === true,
                });
              }
              cursor = page.nextCursor;
            } while (cursor !== undefined);
            return all;
          });
          return { tools };
        } catch (error) {
          return { down: { server: server.name, reason: messageOf(error) } };
        }
      }),
    );
    const catalog: McpCatalog = {
      tools: listed.flatMap((one) => one.tools ?? []),
      down: listed.flatMap((one) => (one.down === undefined ? [] : [one.down])),
    };
    // What was learned with a server away is not kept: it is asked again the next time.
    if (catalog.down.length === 0) {
      // Those that are no longer good are let go of, so that the list is of the actors at work.
      const now = this.#clock();
      for (const [other, one] of this.#catalogs) {
        if (now - one.at >= this.#cacheMs) this.#catalogs.delete(other);
      }
      this.#catalogs.set(key, { at: now, catalog });
    }
    return catalog;
  }

  /** Calls a tool of a server. Rejects when the server cannot be reached or refuses the call. */
  call(
    actor: Actor,
    server: McpServerDeclaration,
    tool: string,
    args: Json,
    signal?: AbortSignal,
  ): Promise<McpResult> {
    return this.#with(actor, server, signal, async (client) => {
      const result = await client.callTool(
        { name: tool, arguments: (args ?? {}) as { [key: string]: unknown } },
        // A call takes as long as it takes: what limits it is its script's own time.
        { ...(signal === undefined ? {} : { signal }), timeout: LONGEST_TIMER_MS },
      );
      return result as unknown as McpResult;
    });
  }

  /** Connects, does one thing, and closes. */
  async #with<T>(
    actor: Actor,
    server: McpServerDeclaration,
    signal: AbortSignal | undefined,
    use: (client: Client) => Promise<T>,
  ): Promise<T> {
    const made = await this.#call(actor, `mcps.${server.name}.headers`, null);
    if (!made.ok) {
      let why = 'they are not valid';
      if (made.kind === 'error') why = made.error.message;
      else if (made.kind === 'lost') why = made.reason;
      else if (made.issues.length > 0) why = issuesText(made.issues);
      throw new Error(`The headers of the MCP server ${server.name} could not be made: ${why}`);
    }
    signal?.throwIfAborted();
    const headers = (made.value ?? {}) as { readonly [name: string]: string };
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { ...headers } },
      ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
    });
    const client = new Client(
      { name: 'acentric', version: '0.0.0' },
      // The newest protocol where the server has it, the older handshake where it does not.
      { versionNegotiation: { mode: 'auto' } },
    );
    try {
      await client.connect(transport, { timeout: this.#timeoutMs });
      return await use(client);
    } finally {
      // A server of the older protocol may keep a session: it is told the session is over.
      await transport.terminateSession().catch(() => {});
      await client.close().catch(() => {});
    }
  }
}
