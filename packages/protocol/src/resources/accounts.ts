// Model accounts, and what was used through them.
//
// A model account is what the calls of a provider's models are made with: a key of the
// provider's. There can be several for a provider, and one of them is that provider's default.
// An agent's calls are made with the account it was given, or with its provider's default.
//
// Every call of a model is written down, answered or failed: who made it, with which account,
// on which model, how many tokens of each kind it took, what it cost and how long it took.
// What it names is kept as it was, so what was spent stays when an actor, an agent or an
// account goes.

import { z } from 'zod';

import { principalRefSchema } from '../auth.ts';
import { accountIdSchema, actorIdSchema, agentIdSchema, userIdSchema } from '../ids.ts';
import { modelIdSchema, providerIdSchema } from '../messages.ts';
import { nameSchema } from '../names.ts';
import { timestampSchema } from '../primitives.ts';

/** A model account, without its credential: nothing gives that back. */
export const accountSchema = z
  .object({
    id: accountIdSchema,
    provider: providerIdSchema,
    name: nameSchema,
    /** What its calls are signed with: a key, or the token of someone signed in. Never which. */
    credential: z.enum(['api_key', 'access_token']),
    /** Whether agents of its provider that were given no account use it. */
    default: z.boolean(),
    /** Whose it is. Null for one that is the engine's, which any agent may be given. */
    owner: userIdSchema.nullable(),
    /** The agents that were given it. */
    agents: z.array(agentIdSchema),
    createdBy: principalRefSchema,
    createdAt: timestampSchema,
  })
  .meta({ id: 'Account' });
export type Account = z.infer<typeof accountSchema>;

const apiKeySchema = z.string().trim().min(1).max(4096);

/**
 * An account to add. Its key is checked with its provider before it is kept. The first
 * account of a provider is that provider's default.
 */
export const createAccountRequestSchema = z
  .strictObject({
    provider: providerIdSchema,
    name: nameSchema,
    apiKey: apiKeySchema,
    /** Makes it its provider's default, in place of the one that was. */
    default: z.boolean().optional(),
  })
  .meta({ id: 'CreateAccountRequest' });
export type CreateAccountRequest = z.infer<typeof createAccountRequestSchema>;

/** What of an account can be changed: its name, its key, and that it is the default. */
export const updateAccountRequestSchema = z
  .strictObject({
    name: nameSchema.optional(),
    /** In place of the key it has. It is checked with the provider first. */
    apiKey: apiKeySchema.optional(),
    /** Makes it its provider's default. Another is made the default to take that from it. */
    default: z.literal(true).optional(),
  })
  .meta({ id: 'UpdateAccountRequest' });
export type UpdateAccountRequest = z.infer<typeof updateAccountRequestSchema>;

// Usage

const total = z.number().int().nonnegative();

/** What the calls of a group add up to. */
export const usageTotalsSchema = z
  .object({
    calls: total,
    /** Of them, those that failed. */
    failed: total,
    /** Every prompt token: those of no cache, read from one, and written to one. */
    totalInput: total,
    input: total,
    cacheRead: total,
    cacheWrite: total,
    output: total,
    reasoning: total,
    /** Searches of the providers' own web search. */
    webSearches: total,
    /** In US dollars, of the calls whose cost is known. */
    cost: z.number().nonnegative(),
    /** How much of `cost` is estimated from prices, not reported by the provider. */
    estimatedCost: z.number().nonnegative(),
    /** Answered calls whose cost is not known: they are in no `cost`. */
    unpriced: total,
    /** How long the calls took, together, in milliseconds. */
    durationMs: total,
    /** When the first of them was made, and the last. Null when there are none. */
    first: timestampSchema.nullable(),
    last: timestampSchema.nullable(),
  })
  .meta({ id: 'UsageTotals' });
export type UsageTotals = z.infer<typeof usageTotalsSchema>;

/** What usage can be added up by. `day` is a day in UTC, as `2026-11-22`. */
/** `root` is the actor at the top of a tree of subagents: what it and all under it used. */
export const USAGE_GROUPS = [
  'agent',
  'actor',
  'root',
  'account',
  'provider',
  'model',
  'day',
] as const;
export type UsageGroup = (typeof USAGE_GROUPS)[number];

/** Which calls are added up, and by what. Each filter narrows them. */
export const usageQuerySchema = z.object({
  /** From this time on. */
  from: z.coerce.number().int().nonnegative().optional(),
  /** Up to, and not at, this time. */
  to: z.coerce.number().int().nonnegative().optional(),
  agent: agentIdSchema.optional(),
  actor: actorIdSchema.optional(),
  /** An actor that was created from outside, and every actor under it. */
  root: actorIdSchema.optional(),
  account: accountIdSchema.optional(),
  provider: providerIdSchema.optional(),
  model: modelIdSchema.optional(),
  /** With it, the totals of each group as well, the one that cost most first. */
  by: z.enum(USAGE_GROUPS).optional(),
});
export type UsageQuery = z.infer<typeof usageQuerySchema>;

export const usageReportSchema = z
  .object({
    totals: usageTotalsSchema,
    /** For a query with `by`: each group by what it is of, such as an agent's ID or a day. */
    groups: z.array(z.object({ key: z.string(), totals: usageTotalsSchema })).optional(),
  })
  .meta({ id: 'UsageReport' });
export type UsageReport = z.infer<typeof usageReportSchema>;
