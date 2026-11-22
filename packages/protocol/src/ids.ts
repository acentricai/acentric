// IDs. Everything the engine keeps has an ID the engine made: nobody outside gives one. An ID
// says what kind of thing it names, never changes, and is all the API's paths take.
//
// What a person calls a thing is its name, and what a caller's own system calls it is its
// external ID (see `names.ts`). Neither is an ID, and neither is ever used as one.
//
// An ID is `<prefix>_<26 characters>`: the prefix is the kind, and the rest is a UUID of
// version 7 in Crockford's base32, lowercase. This is the TypeID format. The UUID starts with
// the time it was made, so IDs of a kind sort in the order they were made.

import { z } from 'zod';

/** The prefix of each kind of ID. */
export const ID_PREFIXES = {
  agent: 'agt',
  deployment: 'dep',
  actor: 'act',
  input: 'inp',
  machine: 'mch',
  sandboxProvider: 'prv',
  account: 'acc',
  user: 'usr',
  session: 'ses',
  key: 'key',
  invite: 'inv',
  auditEvent: 'aud',
  usage: 'usg',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

/** An ID of kind `K`, such as `act_01jd3m5kq8f4xv9t6w2rhb0c7n`. */
export type Id<K extends IdKind = IdKind> = K extends IdKind
  ? `${(typeof ID_PREFIXES)[K]}_${string}`
  : never;

export type AgentId = Id<'agent'>;
export type DeploymentId = Id<'deployment'>;
export type ActorId = Id<'actor'>;
export type InputId = Id<'input'>;
export type MachineId = Id<'machine'>;
export type SandboxProviderId = Id<'sandboxProvider'>;
export type AccountId = Id<'account'>;
export type UserId = Id<'user'>;
export type SessionId = Id<'session'>;
export type KeyId = Id<'key'>;
export type InviteId = Id<'invite'>;
export type AuditEventId = Id<'auditEvent'>;
export type UsageId = Id<'usage'>;

/** Crockford's base32: the digits, then the letters without i, l, o and u. */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** The 26 characters after the prefix. The first holds three bits, so it is 7 at most. */
const SUFFIX = '[0-7][0-9a-hjkmnp-tv-z]{25}';

const KINDS = Object.keys(ID_PREFIXES) as IdKind[];

const PATTERNS = Object.fromEntries(
  KINDS.map((kind) => [kind, new RegExp(`^${ID_PREFIXES[kind]}_${SUFFIX}$`)]),
) as { readonly [K in IdKind]: RegExp };

/** The regular expression an ID of `kind` matches. */
export function idPattern(kind: IdKind): RegExp {
  return PATTERNS[kind];
}

/** Where an ID's time and randomness come from. The engine gives its clock and its own. */
export type IdSource = {
  /** Milliseconds since the Unix epoch. */
  readonly now: number;
  /** Ten random bytes, or more: the first ten are used. */
  readonly random: Uint8Array;
};

/**
 * Makes an ID of `kind` from a time and random bytes. It makes nothing up itself, so that the
 * same two give the same ID.
 */
export function makeId<K extends IdKind>(kind: K, source: IdSource): Id<K> {
  const { now, random } = source;
  if (!Number.isInteger(now) || now < 0 || now >= 2 ** 48) {
    throw new RangeError(
      `An ID's time is a whole number of milliseconds below 2^48: got ${String(now)}`,
    );
  }
  if (random.length < 10) {
    throw new RangeError(`An ID takes 10 random bytes: got ${String(random.length)}`);
  }

  // A UUID of version 7: 48 bits of time, the version, 12 random bits, the variant, 62 random bits.
  let randomBits = 0n;
  for (const byte of random.subarray(0, 10)) randomBits = (randomBits << 8n) | BigInt(byte);
  const high = randomBits >> 62n; // 18 bits, of which 12 are used
  const low = randomBits & ((1n << 62n) - 1n);
  let value =
    (BigInt(now) << 80n) | (0x7n << 76n) | ((high & 0xfffn) << 64n) | (0b10n << 62n) | low;

  let suffix = '';
  for (let index = 0; index < 26; index += 1) {
    suffix = (ALPHABET[Number(value & 31n)] as string) + suffix;
    value >>= 5n;
  }
  return `${ID_PREFIXES[kind]}_${suffix}` as Id<K>;
}

/** Whether `value` is an ID of `kind`. */
export function isId<K extends IdKind>(kind: K, value: unknown): value is Id<K> {
  return typeof value === 'string' && PATTERNS[kind].test(value);
}

/** The kind of an ID and the time it was made, or undefined for what is not an ID. */
export function parseId(
  value: string,
): { readonly kind: IdKind; readonly createdAt: number } | undefined {
  const kind = KINDS.find((candidate) => PATTERNS[candidate].test(value));
  if (kind === undefined) return undefined;
  let bits = 0n;
  for (const character of value.slice(value.lastIndexOf('_') + 1)) {
    bits = (bits << 5n) | BigInt(ALPHABET.indexOf(character));
  }
  return { kind, createdAt: Number(bits >> 80n) };
}

/** The schema of an ID of `kind`. */
export function idSchema<K extends IdKind>(kind: K): z.ZodType<Id<K>, Id<K>> {
  const prefix = ID_PREFIXES[kind];
  return z
    .string()
    .regex(PATTERNS[kind], `An ID of this kind is ${prefix}_ and 26 characters`)
    .meta({
      description: `An ID of kind ${kind}, made by the engine.`,
      examples: [`${prefix}_01jd3m5kq8f4xv9t6w2rhb0c7n`],
    }) as unknown as z.ZodType<Id<K>, Id<K>>;
}

export const agentIdSchema = idSchema('agent');
export const deploymentIdSchema = idSchema('deployment');
export const actorIdSchema = idSchema('actor');
export const inputIdSchema = idSchema('input');
export const machineIdSchema = idSchema('machine');
export const sandboxProviderIdSchema = idSchema('sandboxProvider');
export const accountIdSchema = idSchema('account');
export const userIdSchema = idSchema('user');
export const sessionIdSchema = idSchema('session');
export const keyIdSchema = idSchema('key');
export const inviteIdSchema = idSchema('invite');
export const auditEventIdSchema = idSchema('auditEvent');
export const usageIdSchema = idSchema('usage');
