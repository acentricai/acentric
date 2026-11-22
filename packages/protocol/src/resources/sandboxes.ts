// Sandboxes: machines the engine makes at a provider, where a person would otherwise enrol
// one. Once made, a sandbox is a machine like any other: actors are created on it by its ID,
// and commands go to its daemon.
//
// A provider is where sandboxes are made, and an account at one is added before any is: with
// its API key, for a provider that has keys. A sandbox sleeps when nothing was run on it for
// its idle time, and is started again for what needs it.

import { z } from 'zod';

import { machineIdSchema, sandboxProviderIdSchema } from '../ids.ts';
import { nameSchema } from '../names.ts';
import { timestampSchema } from '../primitives.ts';
import { machineAgentsSchema, machineSchema } from './machines.ts';

/** How long a sandbox may be idle before it is stopped, in seconds: without one said, and its bounds. */
export const DEFAULT_SANDBOX_IDLE_S = 3_600;
export const MIN_SANDBOX_IDLE_S = 60;
export const MAX_SANDBOX_IDLE_S = 2_592_000;

/** The longest a call that makes a sandbox waits for its daemon, in seconds. */
export const SANDBOX_WAIT_MAX_S = 120;

/** How a sandbox stands at its provider, in the engine's words. */
export const sandboxStateSchema = z.enum([
  'starting',
  'running',
  'stopping',
  'stopped',
  'error',
  /** Its provider no longer has it. */
  'gone',
  /** Its provider could not be asked. */
  'unknown',
]);
export type SandboxState = z.infer<typeof sandboxStateSchema>;

/** An account at a provider of sandboxes. Its key is never given back. */
export const sandboxProviderSchema = z
  .object({
    id: sandboxProviderIdSchema,
    /** Which provider it is an account at, such as `docker` or `boat`. */
    kind: z.string(),
    name: nameSchema,
    /** Who the provider says the account belongs to. */
    account: z.string().nullable(),
    /** How many sandboxes were made in it. */
    sandboxes: z.number().int(),
    createdAt: timestampSchema,
  })
  .meta({ id: 'SandboxProvider' });
export type SandboxProviderAccount = z.infer<typeof sandboxProviderSchema>;

export const createSandboxProviderRequestSchema = z
  .strictObject({
    /** The provider: one this engine was set up with. */
    kind: z.string().min(1).max(64),
    name: nameSchema,
    /** The account's API key, for a provider that has keys. It is checked with the provider first. */
    apiKey: z.string().min(1).max(512).optional(),
  })
  .meta({ id: 'CreateSandboxProviderRequest' });
export type CreateSandboxProviderRequest = z.infer<typeof createSandboxProviderRequestSchema>;

export const sandboxSchema = z
  .object({
    /** The machine it is. */
    machine: machineSchema,
    /** The account it was made in, and which provider that is an account at. */
    provider: sandboxProviderIdSchema,
    kind: z.string(),
    /** Its provider's own ID for it. Null until the provider has answered that it made it. */
    providerSandboxId: z.string().nullable(),
    vcpu: z.number(),
    memoryGB: z.number(),
    idleTimeoutSeconds: z.number().int(),
    state: sandboxStateSchema,
  })
  .meta({ id: 'Sandbox' });
export type Sandbox = z.infer<typeof sandboxSchema>;

export const createSandboxRequestSchema = z
  .strictObject({
    /** The account it is made in. */
    provider: sandboxProviderIdSchema,
    /** Its size: one its provider makes. */
    vcpu: z.number().int().min(1),
    memoryGB: z.number().int().min(1),
    /** What the machine is called. One is made up without it. */
    name: nameSchema.optional(),
    /** The agents whose actors may work on it. None unless said. */
    agents: machineAgentsSchema.optional(),
    /** Seconds it may be idle before it is stopped: an hour without it. */
    idleTimeoutSeconds: z.number().int().min(MIN_SANDBOX_IDLE_S).max(MAX_SANDBOX_IDLE_S).optional(),
    /** Seconds the call waits for its daemon to connect: 60 without it. It answers when they run out. */
    wait: z.number().min(0).max(SANDBOX_WAIT_MAX_S).optional(),
  })
  .meta({ id: 'CreateSandboxRequest' });
export type CreateSandboxRequest = z.infer<typeof createSandboxRequestSchema>;

export const sandboxProviderParam = z.object({ provider: sandboxProviderIdSchema });
export const sandboxParam = z.object({ machine: machineIdSchema });
