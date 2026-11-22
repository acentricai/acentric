// Agents and their deployments.
//
// An agent is what a developer deployed under a name. Each deploy of code that differs from
// the last is a deployment: it has a number, its version, counted from 1 for its agent, and
// never changes.
//
// One of an agent's deployments is the active one. A new actor is created on it, and an actor
// that is not pinned to a version moves to it at the start of its next turn. A deploy makes
// its deployment the active one unless it says not to, and any deployment can be made the
// active one again: that is how a deploy is taken back.

import { z } from 'zod';

import { principalRefSchema } from '../auth.ts';
import { agentIdSchema, deploymentIdSchema } from '../ids.ts';
import { agentDefinitionSchema, bundleManifestSchema, secretNameSchema } from '../manifest.ts';
import { providerIdSchema } from '../messages.ts';
import { nameSchema } from '../names.ts';
import { pageQuerySchema, timestampSchema } from '../primitives.ts';

/** A deployment, as something else names it: its ID, and its number for a person. */
export const deploymentRefSchema = z.object({
  id: deploymentIdSchema,
  /** Its number among its agent's deployments, from 1. */
  version: z.number().int().positive(),
});
export type DeploymentRef = z.infer<typeof deploymentRefSchema>;

export const agentSchema = z
  .object({
    id: agentIdSchema,
    name: nameSchema,
    /** The provider of its model. It is the same for as long as the agent is. */
    provider: providerIdSchema,
    /** What a new actor is created on, and what an actor that is not pinned moves to. */
    activeDeployment: deploymentRefSchema,
    /** Its newest deployment. It is the active one unless another was made so. */
    latestDeployment: deploymentRefSchema,
    createdAt: timestampSchema,
  })
  .meta({ id: 'Agent' });
export type Agent = z.infer<typeof agentSchema>;

/** A deployment without its definition: what a list gives. */
export const deploymentSummarySchema = z
  .object({
    id: deploymentIdSchema,
    agent: agentIdSchema,
    version: z.number().int().positive(),
    /** The SHA-256 of its code, in hex. */
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    manifest: bundleManifestSchema,
    createdBy: principalRefSchema,
    createdAt: timestampSchema,
  })
  .meta({ id: 'DeploymentSummary' });
export type DeploymentSummary = z.infer<typeof deploymentSummarySchema>;

export const deploymentSchema = deploymentSummarySchema
  .extend({ definition: agentDefinitionSchema })
  .meta({ id: 'Deployment' });
export type Deployment = z.infer<typeof deploymentSchema>;

/** The most code a deploy sends, in characters. */
export const MAX_BUNDLE_SIZE = 10 * 1024 * 1024;

/**
 * A deploy: the code of the agent of this name. The agent is made when there is none of the
 * name. Code that is the agent's newest already makes no new deployment.
 */
export const deployRequestSchema = z
  .strictObject({
    agent: nameSchema,
    manifest: bundleManifestSchema,
    /** The agent's code: one ES module. */
    code: z.string().min(1).max(MAX_BUNDLE_SIZE),
    /**
     * Whether the deployment becomes the active one. False keeps it for actors that are
     * pinned to it, and for making active later.
     */
    activate: z.boolean().default(true),
  })
  .meta({ id: 'DeployRequest' });
export type DeployRequest = z.infer<typeof deployRequestSchema>;

export const deployResponseSchema = z
  .object({
    agent: agentSchema,
    deployment: deploymentSchema,
    /** False when the code was the agent's newest already: nothing was made. */
    created: z.boolean(),
    /** The secrets the code says it reads that the agent has none of yet. */
    missingSecrets: z.array(secretNameSchema),
  })
  .meta({ id: 'DeployResponse' });
export type DeployResponse = z.infer<typeof deployResponseSchema>;

/** What of an agent can be changed: which of its deployments is the active one. */
export const updateAgentRequestSchema = z
  .strictObject({
    /** The version of the deployment to make active. */
    activeVersion: z.number().int().positive(),
  })
  .meta({ id: 'UpdateAgentRequest' });
export type UpdateAgentRequest = z.infer<typeof updateAgentRequestSchema>;

/** Which agents a list gives. */
export const listAgentsQuerySchema = pageQuerySchema.extend({
  /** The agent of this name, if there is one. */
  name: nameSchema.optional(),
});
export type ListAgentsQuery = z.infer<typeof listAgentsQuerySchema>;

// Secrets

/** A secret of an agent's, as it is listed: its name, never its value. */
export const secretSchema = z
  .object({
    name: secretNameSchema,
    updatedAt: timestampSchema,
  })
  .meta({ id: 'Secret' });
export type Secret = z.infer<typeof secretSchema>;

/** The most a secret's value is, in characters. */
export const MAX_SECRET_SIZE = 64 * 1024;

/** A secret's value, set in place of the one it had. Nothing reads it back but the agent's code. */
export const setSecretRequestSchema = z
  .strictObject({ value: z.string().min(1).max(MAX_SECRET_SIZE) })
  .meta({ id: 'SetSecretRequest' });
export type SetSecretRequest = z.infer<typeof setSecretRequestSchema>;
