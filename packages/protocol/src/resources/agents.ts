// Agents and their deployments.
//
// An agent is what a developer deployed under a name. Each deploy of code that differs from
// the last is a deployment: it has a number, counted from 1 for its agent, and never changes.
//
// How actors move from one deployment to the next is not decided, so nothing here says: an
// agent has a newest deployment, a new actor is created on it, and that is all.

import { z } from 'zod';

import { principalRefSchema } from '../auth.ts';
import { agentIdSchema, deploymentIdSchema } from '../ids.ts';
import { agentDefinitionSchema, bundleManifestSchema } from '../manifest.ts';
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
    /** Its newest deployment: what a new actor is created on. */
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
  })
  .meta({ id: 'DeployRequest' });
export type DeployRequest = z.infer<typeof deployRequestSchema>;

export const deployResponseSchema = z
  .object({
    agent: agentSchema,
    deployment: deploymentSchema,
    /** False when the code was the agent's newest already: nothing was made. */
    created: z.boolean(),
  })
  .meta({ id: 'DeployResponse' });
export type DeployResponse = z.infer<typeof deployResponseSchema>;

/** Which agents a list gives. */
export const listAgentsQuerySchema = pageQuerySchema.extend({
  /** The agent of this name, if there is one. */
  name: nameSchema.optional(),
});
export type ListAgentsQuery = z.infer<typeof listAgentsQuerySchema>;
