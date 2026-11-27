// Sandboxes: machines the engine makes at a provider, where a person would otherwise enrol
// one. Once made, a sandbox is a machine like any other: actors are created on it by its ID,
// and commands go to its daemon.
//
// A provider is where sandboxes are made, and an account at one is added before any is: with
// its API key, for a provider that has keys. A sandbox sleeps when nothing was run on it for
// its idle time, and is started again for what needs it.

import { z } from 'zod';

import { machineIdSchema, sandboxProviderIdSchema, sandboxTemplateIdSchema } from '../ids.ts';
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
    /**
     * The template it is made from: a ready one of the same account. Without it, the one the
     * server was started with.
     */
    template: sandboxTemplateIdSchema.optional(),
  })
  .meta({ id: 'CreateSandboxRequest' });
export type CreateSandboxRequest = z.infer<typeof createSandboxRequestSchema>;

// Templates: what an account's sandboxes can be made from, in place of the server's own. One is
// built in a sandbox of the account: its script is run there, the machine program is put in
// after it, and the sandbox's disk is saved at the provider. The builder is then deleted.

/** The longest script a template is built with, in bytes. */
export const TEMPLATE_SCRIPT_MAX_BYTES = 65_536;
/** How much of a build's output is kept, in bytes: its end. */
export const TEMPLATE_OUTPUT_MAX_BYTES = 65_536;

/** How many bytes a text is in UTF-8. */
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** How a template's build stands. */
export const sandboxTemplateStatusSchema = z.enum(['building', 'ready', 'failed']);
export type SandboxTemplateStatus = z.infer<typeof sandboxTemplateStatusSchema>;

export const sandboxTemplateSchema = z
  .object({
    id: sandboxTemplateIdSchema,
    /** The account it was built in, and is used in. */
    provider: sandboxProviderIdSchema,
    name: nameSchema,
    /** What it was built with: a shell script, run with bash. */
    script: z.string(),
    status: sandboxTemplateStatusSchema,
    /** What the build printed, its end: the script's output, then the machine program's install. */
    output: z.string(),
    /** Why it failed. Null unless it did. */
    error: z.string().nullable(),
    createdAt: timestampSchema,
    /** When its build ended. Null while it is building. */
    finishedAt: timestampSchema.nullable(),
  })
  .meta({ id: 'SandboxTemplate' });
export type SandboxTemplate = z.infer<typeof sandboxTemplateSchema>;

export const createSandboxTemplateRequestSchema = z
  .strictObject({
    name: nameSchema,
    /** A shell script, run with bash as the sandbox's user, who may use sudo. */
    script: z
      .string()
      .min(1)
      .refine((script) => utf8Bytes(script) <= TEMPLATE_SCRIPT_MAX_BYTES, {
        message: `A script is at most ${String(TEMPLATE_SCRIPT_MAX_BYTES)} bytes`,
      }),
  })
  .meta({ id: 'CreateSandboxTemplateRequest' });
export type CreateSandboxTemplateRequest = z.infer<typeof createSandboxTemplateRequestSchema>;

export const sandboxProviderParam = z.object({ provider: sandboxProviderIdSchema });
export const sandboxTemplateParam = z.object({
  provider: sandboxProviderIdSchema,
  template: sandboxTemplateIdSchema,
});
export const sandboxParam = z.object({ machine: machineIdSchema });
