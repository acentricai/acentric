// The local runner: instances kept in a store across restarts, handlers run
// in child processes. It follows RUNNERS.md; docs/local-runner.md has the
// design.

export { openSqliteStore } from './store/sqlite.js';
export { StoreError } from './store/types.js';
export type {
  AgentRef,
  Bundle,
  InboxItem,
  InstanceFilter,
  InstanceRecord,
  InstanceSummary,
  KindInfo,
  LoadedInstance,
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
  InstanceEvent,
  InstanceInfo,
  InstanceListing,
  LocalRunnerKinds,
  LocalRunnerOptions,
  RunnerErrorCode,
  RunningEffect,
  Status,
  SubscribeOptions,
} from './runner.js';
