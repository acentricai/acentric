// The protocol between applications and acentric runners.

export { PROTOCOL_VERSION } from './messages.js';
export type * from './messages.js';
export { isJson, lineSplitter, parseMessage, RpcError, RpcPeer } from './rpc.js';
export type { RpcHandlers, RpcMessage } from './rpc.js';
