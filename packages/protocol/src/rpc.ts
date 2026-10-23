// A JSON-RPC 2.0 peer over any channel that carries Json messages: both
// sides can send requests and notifications. Applications and runners use it
// over stdio and WebSocket, and the local runner over its handler hosts' IPC
// channels.

import type { Json, JsonObject } from '@acentric/types';

export type RpcMessage = JsonObject;

export type RpcHandlers = {
  /** Answers a request; a thrown error goes back as a JSON-RPC error. */
  request(method: string, params: Json): Promise<Json>;
  notify(method: string, params: Json): void;
};

export class RpcError extends Error {
  readonly code: number;
  readonly data: Json | undefined;

  constructor(code: number, message: string, data?: Json) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

type Pending = { resolve: (value: Json) => void; reject: (error: Error) => void };

export class RpcPeer {
  readonly #send: (message: RpcMessage) => void;
  readonly #handlers: RpcHandlers;
  readonly #pending = new Map<number, Pending>();
  #next = 1;
  #closed: Error | null = null;

  constructor(send: (message: RpcMessage) => void, handlers: RpcHandlers) {
    this.#send = send;
    this.#handlers = handlers;
  }

  request(method: string, params: Json): Promise<Json> {
    if (this.#closed !== null) return Promise.reject(this.#closed);
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: Json): void {
    if (this.#closed === null) this.#send({ jsonrpc: '2.0', method, params });
  }

  /** Handles one message from the other side. */
  receive(message: unknown): void {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return;
    const id: unknown = Reflect.get(message, 'id');
    const method: unknown = Reflect.get(message, 'method');
    const params: unknown = Reflect.get(message, 'params');
    if (typeof method === 'string') {
      const json = isJson(params) ? params : null;
      if (typeof id === 'number' || typeof id === 'string') this.#answer(id, method, json);
      else this.#handlers.notify(method, json);
      return;
    }
    if (typeof id !== 'number') return;
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    const error: unknown = Reflect.get(message, 'error');
    if (typeof error === 'object' && error !== null) {
      const code: unknown = Reflect.get(error, 'code');
      const text: unknown = Reflect.get(error, 'message');
      const data: unknown = Reflect.get(error, 'data');
      pending.reject(
        new RpcError(
          typeof code === 'number' ? code : -32603,
          typeof text === 'string' ? text : 'unknown error',
          isJson(data) ? data : undefined,
        ),
      );
    } else {
      const result: unknown = Reflect.get(message, 'result');
      pending.resolve(isJson(result) ? result : null);
    }
  }

  /** Fails every request still waiting for an answer, and any later one. */
  close(reason: Error): void {
    this.#closed = reason;
    for (const pending of this.#pending.values()) pending.reject(reason);
    this.#pending.clear();
  }

  #answer(id: number | string, method: string, params: Json): void {
    this.#handlers.request(method, params).then(
      (result) => {
        if (this.#closed === null) this.#send({ jsonrpc: '2.0', id, result });
      },
      (error: unknown) => {
        if (this.#closed !== null) return;
        const code = error instanceof RpcError ? error.code : -32603;
        const message = error instanceof Error ? error.message : String(error);
        const data = error instanceof RpcError ? error.data : undefined;
        this.#send({
          jsonrpc: '2.0',
          id,
          error: { code, message, ...(data === undefined ? {} : { data }) },
        });
      },
    );
  }
}

/**
 * Splits a stream of text into lines, for one JSON message per line.
 * Returns a function to feed it chunks as they arrive.
 */
export function lineSplitter(line: (text: string) => void): (chunk: string) => void {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
      const text = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (text.length > 0) line(text);
    }
  };
}

/** Parses one message, or returns null for text that is not Json. */
export function parseMessage(text: string): Json | null {
  try {
    const value: unknown = JSON.parse(text);
    return isJson(value) ? value : null;
  } catch {
    return null;
  }
}

/** Whether a value is plain Json. */
export function isJson(value: unknown): value is Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  if (typeof value !== 'object') return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.values(value).every((item) => item !== undefined && isJson(item))
  );
}
