// Runs an agent's code. There are two executors. One keeps the code apart from the engine, in
// V8 isolates of workerd processes: it is what an engine runs agents with. The other runs the
// code in the engine's own process, with nothing between the two: it is for tests, and for a
// developer's own agent on their own computer, should a command for that be wanted.
//
// Both do the same things, and are held to the same tests. An engine is given either.

export { InProcessExecutor } from './in-process.ts';
export type { SecretSource } from './in-process.ts';
export { IsolateExecutor } from './isolate-executor.ts';
export type { IsolateOptions } from './isolate-executor.ts';
export type { Network } from './isolate/config.ts';
export type { PoolOptions, PoolStats, ProcessStats, RecycleReason } from './isolate/pool.ts';
export type { LossKind } from './isolate/sandbox.ts';
export { BundleError, CallFailed, SandboxLost, UnsupportedProtocol } from './errors.ts';
