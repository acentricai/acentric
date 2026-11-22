// Runs an agent's code. There is one executor here so far, which runs it in the engine's own
// process, for a developer's own agent on their own computer. The one that keeps code apart
// from the engine is to come.

export { InProcessExecutor } from './in-process.ts';
export type { SecretSource } from './in-process.ts';
export { BundleError, UnsupportedProtocol } from './errors.ts';
