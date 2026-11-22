// Machines: the places commands run. A machine is a computer with the daemon on it. Its daemon
// connects to the engine, never the other way.
//
// A machine is added by a name, which gives a token. Its daemon enrols once with the token and
// its public key, and proves itself with that key on every connection after.

import { z } from 'zod';

import { agentIdSchema, machineIdSchema } from '../ids.ts';
import { nameSchema } from '../names.ts';
import { timestampSchema } from '../primitives.ts';

/** The agents whose actors may work on a machine: their IDs, or `*` for every agent. */
export const machineAgentsSchema = z.union([z.literal('*'), z.array(agentIdSchema)]);
export type MachineAgents = z.infer<typeof machineAgentsSchema>;

export const machineSchema = z
  .object({
    id: machineIdSchema,
    name: nameSchema,
    /** The agents whose actors may work on it. It is for none until it is said which. */
    agents: machineAgentsSchema,
    /** Whether its daemon has enrolled. */
    enrolled: z.boolean(),
    /** Whether its daemon is connected now. */
    online: z.boolean(),
    /** What its daemon last said of it. Null until it has connected once. */
    os: z.string().nullable(),
    arch: z.string().nullable(),
    /** The home directory of its daemon's user: what `~` is there. */
    home: z.string().nullable(),
    hostname: z.string().nullable(),
    /** Its daemon's version. */
    version: z.string().nullable(),
    /**
     * Whether its daemon is the build this engine hands out for its system. Null when that is
     * not known: it has not connected, or the engine hands out none for it.
     */
    current: z.boolean().nullable(),
    createdAt: timestampSchema,
    enrolledAt: timestampSchema.nullable(),
    lastSeenAt: timestampSchema.nullable(),
  })
  .meta({ id: 'Machine' });
export type Machine = z.infer<typeof machineSchema>;

export const createMachineRequestSchema = z
  .strictObject({
    name: nameSchema,
    agents: machineAgentsSchema.optional(),
  })
  .meta({ id: 'CreateMachineRequest' });
export type CreateMachineRequest = z.infer<typeof createMachineRequestSchema>;

/** A token a machine's daemon enrols with. It is shown once, and works once. */
export const machineTokenSchema = z
  .object({
    machine: machineSchema,
    token: z.string(),
    expiresAt: timestampSchema,
  })
  .meta({ id: 'MachineToken' });
export type MachineToken = z.infer<typeof machineTokenSchema>;

export const updateMachineRequestSchema = z
  .strictObject({
    name: nameSchema.optional(),
    /** The agents it is for from now on. Actors that are on it stay. */
    agents: machineAgentsSchema.optional(),
  })
  .meta({ id: 'UpdateMachineRequest' });
export type UpdateMachineRequest = z.infer<typeof updateMachineRequestSchema>;

export const listMachinesQuerySchema = z.object({
  /** The machine of this name, if there is one. */
  name: nameSchema.optional(),
});

/** What a daemon enrols with: the machine's token, and the public half of its key. */
export const enrolMachineRequestSchema = z
  .strictObject({
    token: z.string().min(1).max(512),
    /** An Ed25519 public key, as base64 of its SubjectPublicKeyInfo. */
    publicKey: z.string().min(1).max(512),
  })
  .meta({ id: 'EnrolMachineRequest' });

/** What became of asking a machine's daemon to take the engine's build. */
export const machineUpdateSchema = z
  .object({
    machine: machineSchema,
    /** False when its daemon was that build already. */
    updated: z.boolean(),
  })
  .meta({ id: 'MachineUpdate' });
export type MachineUpdate = z.infer<typeof machineUpdateSchema>;

/** Variables by name, as a command is run with them. */
export const machineEnvSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'A variable is named with letters, digits and _'),
  z.string().max(64 * 1024),
);
export type MachineEnv = z.infer<typeof machineEnvSchema>;

/** The machine an actor works on, as it is given when the actor is created. */
export const actorMachineRequestSchema = z.strictObject({
  id: machineIdSchema,
  /** Its working directory there: where its commands start. Absolute, or from `~`. */
  cwd: z
    .string()
    .max(4096)
    .regex(/^(\/|~$|~\/)/, 'A working directory is a path that starts with / or ~'),
  /** Variables every command of the actor is run with, over the machine's own. Kept sealed. */
  env: machineEnvSchema.optional(),
});
export type ActorMachineRequest = z.infer<typeof actorMachineRequestSchema>;

/** The machine an actor works on, as it is read: its variables by name, never their values. */
export const actorMachineSchema = z.object({
  id: machineIdSchema,
  cwd: z.string(),
  env: z.array(z.string()),
});
export type ActorMachine = z.infer<typeof actorMachineSchema>;
