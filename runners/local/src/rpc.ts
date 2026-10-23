// A JSON-RPC 2.0 peer over any channel that carries Json messages: both
// sides can send requests and notifications. The runner uses it to talk to
// its handler hosts over their IPC channel.

import type { Json, JsonObject } from '@acentric/types';

import { isJson } from './json.js';

export type RpcMessage = JsonObject;

export type RpcHandlers = {
  /** Answers a request; a thrown error goes back as a JSON-RPC error. */
  request(method: string, params: Json): Promise<Json>;
  notify(method: string, params: Json): void;
};

export class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
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
      pending.reject(new RpcError(typeof code === 'number' ? code : -32603, String(text)));
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
        this.#send({ jsonrpc: '2.0', id, error: { code, message } });
      },
    );
  }
}
