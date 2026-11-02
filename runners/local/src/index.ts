// The local runner: sessions kept in a store across restarts, handlers run
// in child processes. It follows docs/reference/runner-spec.md; docs/reference/local-runner.md has the
// design.

export { openFileStore } from './store/files.js';
export type { FileStoreOptions } from './store/files.js';
export { openStore } from './store/open.js';
export { openSqliteStore } from './store/sqlite.js';
export { StoreError } from './store/types.js';
export type {
  AgentRef,
  Bundle,
  InboxItem,
  SessionFilter,
  SessionRecord,
  SessionStart,
  SessionSummary,
  KindInfo,
  LoadedSession,
  JournalRange,
  LogRange,
  RequestRecord,
  StepCommit,
  Store,
  StoreErrorCode,
  StoredEffect,
} from './store/types.js';

export { createLocalRunner, LocalRunner, RunnerError } from './runner.js';
export type {
  Answer,
  DeployBundle,
  SessionEvent,
  SessionInfo,
  SessionListing,
  LocalRunnerKinds,
  LocalRunnerOptions,
  ProvidedEffect,
  Provider,
  Provision,
  ReplayReport,
  RunnerErrorCode,
  RunningEffect,
  Status,
  SubscribeOptions,
} from './runner.js';
export type { HostOutcome } from './host/pool.js';
export { connect, RUNNER_NAME } from './server/connection.js';
export type { Channel, Connection } from './server/connection.js';
export { serveStreams, serveWebSocket } from './server/transports.js';
export type { WebSocketListener } from './server/transports.js';
