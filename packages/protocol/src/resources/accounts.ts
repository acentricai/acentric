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
import {
  accountIdSchema,
  actorIdSchema,
  agentIdSchema,
  signInIdSchema,
  userIdSchema,
} from '../ids.ts';
import { modelIdSchema, providerIdSchema } from '../messages.ts';
import { nameSchema } from '../names.ts';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, timestampSchema } from '../primitives.ts';

/** A model account, without its credential: nothing gives that back. */
export const accountSchema = z
  .object({
    id: accountIdSchema,
    provider: providerIdSchema,
    name: nameSchema,
    /** What its calls are signed with: a key, or the token of someone signed in. Never which. */
    credential: z.enum(['api_key', 'access_token']),
    /** For an account made by signing in: whose sign-in it is, and whether it has ended. */
    signIn: z
      .object({
        /** The email of whoever signed in, when the provider said it. */
        email: z.string().nullable(),
        /**
         * Why its calls cannot be made until it is signed in again, once its sign-in has ended
         * at the provider. Left out while it holds.
         */
        signedOut: z.string().optional(),
      })
      .optional(),
    /** Whether an actor of its provider that is created without an account is given it. */
    default: z.boolean(),
    /** Whose it is. Null for one that is the engine's, which any actor may be given. */
    owner: userIdSchema.nullable(),
    /** How many actors that are not archived were given it: while any are, it is kept. */
    actors: z.number().int().nonnegative(),
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

// Signing in

/**
 * A sign-in to start: for a new account, its name and whether it is its provider's default,
 * as when an account is added with a key; or, to sign an account in again, the account.
 */
export const startSignInRequestSchema = z
  .union([
    z.strictObject({ name: nameSchema, default: z.boolean().optional() }),
    z.strictObject({ account: accountIdSchema }),
  ])
  .meta({ id: 'StartSignInRequest' });
export type StartSignInRequest = z.infer<typeof startSignInRequestSchema>;

/** A sign-in that was started, and waits to be finished. */
export const signInSchema = z
  .object({
    id: signInIdSchema,
    /** The page the person signs in at, in their own browser. */
    url: z.string(),
    /** After this, it cannot be finished. */
    expiresAt: timestampSchema,
    /** The account it signs in again, for one that does. */
    account: accountIdSchema.optional(),
  })
  .meta({ id: 'SignIn' });
export type SignIn = z.infer<typeof signInSchema>;

/** What finishes a sign-in: the address the person's browser was sent to once they had signed in. */
export const finishSignInRequestSchema = z
  .strictObject({ url: z.string().trim().min(1).max(16_384) })
  .meta({ id: 'FinishSignInRequest' });
export type FinishSignInRequest = z.infer<typeof finishSignInRequestSchema>;

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
    /**
     * How long an answered call took: half took no longer than `medianMs`, and nineteen in
     * twenty no longer than `p95Ms`. Null when no call was answered.
     */
    medianMs: total.nullable(),
    p95Ms: total.nullable(),
    /** When the first of them was made, and the last. Null when there are none. */
    first: timestampSchema.nullable(),
    last: timestampSchema.nullable(),
  })
  .meta({ id: 'UsageTotals' });
export type UsageTotals = z.infer<typeof usageTotalsSchema>;

/**
 * What usage can be added up by. `day` is a day, as `2026-11-22`, and `hour` an hour of one, as
 * `2026-11-22T13`: in UTC, or in the time zone asked for. `root` is the actor at the top of a
 * tree of subagents: what it and all under it used. `failure` is the kind of failure of a call
 * that failed, and empty for one that was answered. `kind` is `turn` or `compaction`. `version`
 * is the version of its agent a call was made on: of use with an agent asked for.
 */
export const USAGE_GROUPS = [
  'agent',
  'actor',
  'root',
  'account',
  'provider',
  'model',
  'day',
  'hour',
  'failure',
  'kind',
  'version',
] as const;
export type UsageGroup = (typeof USAGE_GROUPS)[number];

/** What a call of a model was for: a turn of its actor, or compacting the actor's conversation. */
export const USAGE_KINDS = ['turn', 'compaction'] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

/** A time zone, as the IANA database names it: `Asia/Kolkata`, `UTC`. */
export const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((zone) => {
    try {
      return new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone !== '';
    } catch {
      return false;
    }
  }, 'A time zone is one the IANA database names, such as Asia/Kolkata or UTC')
  .meta({ examples: ['Asia/Kolkata'] });

/** Which calls a query is of. Each filter narrows them. */
const usageFilterSchema = z.object({
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
  /** The calls of turns, or those that compacted a conversation. Both without it. */
  kind: z.enum(USAGE_KINDS).optional(),
  /** The calls that failed, with `true`; those that were answered, with `false`. */
  failed: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});

/** Which calls are added up, and by what. */
export const usageQuerySchema = usageFilterSchema.extend({
  /** With it, the totals of each group as well, the one that cost most first. */
  by: z.enum(USAGE_GROUPS).optional(),
  /** With `by`, each group's totals by this as well: such as each day's by provider. */
  split: z.enum(USAGE_GROUPS).optional(),
  /** The time zone days and hours are of. UTC without it. */
  tz: timeZoneSchema.optional(),
});
export type UsageQuery = z.infer<typeof usageQuerySchema>;

/** What the calls of one group add up to, and with `split`, its own groups. */
const usageGroupSchema = z.object({
  key: z.string(),
  totals: usageTotalsSchema,
  /** For a query with `split`: this group's calls, by what `split` names, as `groups` are. */
  groups: z.array(z.object({ key: z.string(), totals: usageTotalsSchema })).optional(),
});

export const usageReportSchema = z
  .object({
    totals: usageTotalsSchema,
    /** For a query with `by`: each group by what it is of, such as an agent's ID or a day. */
    groups: z.array(usageGroupSchema).optional(),
  })
  .meta({ id: 'UsageReport' });
export type UsageReport = z.infer<typeof usageReportSchema>;

/** Which calls are listed: the filters of usage, and a page of them. */
export const usageCallsQuerySchema = usageFilterSchema.extend({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().min(1).optional(),
});
export type UsageCallsQuery = z.infer<typeof usageCallsQuerySchema>;

/** One call of a model, as it was written down. */
export const usageCallSchema = z
  .object({
    at: timestampSchema,
    actor: actorIdSchema,
    /** The actor at the top of its tree of subagents: itself, for one created from outside. */
    root: actorIdSchema,
    agent: agentIdSchema,
    /** The version of its agent the call was made on. */
    version: z.number().int().nonnegative(),
    /** The model account it was made with. Null when none says which. */
    account: accountIdSchema.nullable(),
    provider: providerIdSchema,
    model: modelIdSchema,
    kind: z.enum(USAGE_KINDS),
    /** The kind of failure, for a call that failed. */
    failure: z.string().nullable(),
    totalInput: total,
    input: total,
    cacheRead: total,
    cacheWrite: total,
    output: total,
    reasoning: total,
    webSearches: total,
    /** In US dollars. Null when it is not known. */
    cost: z.number().nonnegative().nullable(),
    /** Whether the provider reported the cost, or it was estimated from prices. */
    costSource: z.enum(['reported', 'estimated']).nullable(),
    durationMs: total,
  })
  .meta({ id: 'UsageCall' });
export type UsageCall = z.infer<typeof usageCallSchema>;
