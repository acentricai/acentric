// Who may do what. This is the model alone: how a person signs in, and how a credential is
// checked, are the server's.
//
// Two kinds of principal call the engine. A person, signed in, has a role, and the role says
// what they may do across the whole engine. An API key has a scope, which is what it reaches,
// and permissions, which are what it may do there.
//
// One engine is one organisation's, so there is nothing above the engine to belong to.

import { z } from 'zod';

import { actorIdSchema, agentIdSchema, keyIdSchema, sessionIdSchema, userIdSchema } from './ids.ts';
import { timestampSchema } from './primitives.ts';

/** Everything that can be allowed. Each route takes one. */
export const PERMISSIONS = [
  /** Reading agents and their deployments. */
  'agents:read',
  /** Deploying an agent or a new version of one, and deleting an agent. */
  'agents:deploy',
  /** Setting, listing and removing an agent's secrets. Nothing reads a secret's value back. */
  'secrets:write',
  /** Reading an actor: where it stands, its conversation, its inputs. */
  'actors:read',
  /** Creating an actor, changing it, and archiving it. */
  'actors:write',
  /** Sending an actor inputs. */
  'actors:send',
  /** Interrupting an actor, and having it try a failed turn again. */
  'actors:stop',
  /** Adding, changing and removing machines and sandboxes. */
  'machines:manage',
  /** Running commands on a machine, and reading and writing its files, as the operator. */
  'machines:run',
  /** Adding, changing and removing the accounts model calls are made on. */
  'accounts:manage',
  /** Making, listing and revoking API keys. */
  'keys:manage',
  /** Adding and removing people, and changing their roles. */
  'users:manage',
  /** Reading the audit log. */
  'audit:read',
  /** Reading what model calls used and cost. */
  'usage:read',
] as const;

export const permissionSchema = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof permissionSchema>;

// Scopes

/** What an API key reaches: the whole engine, one agent with its actors, or one actor. */
export const scopeSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('engine') }),
    z.object({ type: z.literal('agent'), agent: agentIdSchema }),
    z.object({ type: z.literal('actor'), actor: actorIdSchema }),
  ])
  .meta({ id: 'Scope' });
export type Scope = z.infer<typeof scopeSchema>;

export type ScopeType = Scope['type'];

/** The permissions a key of each scope may hold: those that mean something there. */
export const HOLDABLE: { readonly [T in ScopeType]: readonly Permission[] } = {
  engine: PERMISSIONS,
  agent: [
    'agents:read',
    'agents:deploy',
    'secrets:write',
    'actors:read',
    'actors:write',
    'actors:send',
    'actors:stop',
    'keys:manage',
    'usage:read',
  ],
  actor: ['actors:read', 'actors:send', 'actors:stop'],
};

/** Whether a key of scope `type` may hold `permission`. */
export function isHoldable(type: ScopeType, permission: Permission): boolean {
  return HOLDABLE[type].includes(permission);
}

// Roles

/** A person's role, from the least it may do to the most. */
export const ROLES = ['viewer', 'member', 'admin', 'owner'] as const;

export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

const VIEWER: readonly Permission[] = ['agents:read', 'actors:read', 'usage:read'];

const MEMBER: readonly Permission[] = [
  ...VIEWER,
  'agents:deploy',
  'secrets:write',
  'actors:write',
  'actors:send',
  'actors:stop',
  'machines:run',
  'keys:manage',
];

const ADMIN: readonly Permission[] = [
  ...MEMBER,
  'machines:manage',
  'accounts:manage',
  'users:manage',
  'audit:read',
];

/**
 * What each role may do, across the whole engine. An owner and an admin hold the same
 * permissions. They differ in two rules no permission says: only an owner changes the role of
 * an admin or an owner, and an engine always has an owner.
 */
export const ROLE_PERMISSIONS: { readonly [R in Role]: readonly Permission[] } = {
  viewer: VIEWER,
  member: MEMBER,
  admin: ADMIN,
  owner: PERMISSIONS,
};

/** Whether `role` holds `permission`. */
export function roleHolds(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Whether `role` is `other` or more: an owner is at least an admin, and so on down. */
export function isAtLeast(role: Role, other: Role): boolean {
  return ROLES.indexOf(role) >= ROLES.indexOf(other);
}

// Principals

/** Who did something, for what records it: a person, a key, or the engine itself. */
export const principalRefSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('user'), id: userIdSchema }),
    z.object({ type: z.literal('key'), id: keyIdSchema }),
    z.object({ type: z.literal('system') }),
  ])
  .meta({ id: 'PrincipalRef' });
export type PrincipalRef = z.infer<typeof principalRefSchema>;

/**
 * Who a request is from, as far as what it may do goes: what `GET /v1/me` answers. A person
 * reaches the whole engine, so only a key says its scope.
 */
export const principalSchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('user'),
      user: userIdSchema,
      email: z.email(),
      role: roleSchema,
      permissions: z.array(permissionSchema),
      /** The session the request came with. */
      session: sessionIdSchema,
    }),
    z.object({
      type: z.literal('key'),
      key: keyIdSchema,
      /** The person it belongs to. Null for a key that is nobody's: a service's. */
      owner: userIdSchema.nullable(),
      scope: scopeSchema,
      permissions: z.array(permissionSchema),
      /** When it stops working. Null for one that does not. */
      expiresAt: timestampSchema.nullable(),
    }),
  ])
  .meta({ id: 'Principal' });
export type Principal = z.infer<typeof principalSchema>;
