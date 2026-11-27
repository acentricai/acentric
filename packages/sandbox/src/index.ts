// The providers sandboxes are made at. What a provider is to the engine is the engine's own,
// `SandboxProvider`: it is given again from here, for whoever writes one.

export type {
  NewSandbox,
  ProviderSandbox,
  SandboxAccount,
  SandboxProvider,
  TemplateBuild,
} from '@acentric/core';
export { ProviderFailed, TemplateFailed, providerFailure } from '@acentric/core';

export {
  PROVISION_FILE,
  SANDBOX_HOME,
  SANDBOX_UID,
  checkDockerHost,
  docker,
  dockerState,
} from './docker.ts';
export type { DockerOptions } from './docker.ts';

export { BOAT_PROVISION_PATH, BOAT_SIZES, boat, boatState } from './boat.ts';
export { BOAT_BOOT, BOAT_UNIT } from './boat-template.ts';
export type { BoatOptions } from './boat.ts';
