// People, their sessions, the API keys, and the record of what was done.
//
// How a person signs in is not here: these are what there is once they have.

import { z } from 'zod';

import { permissionSchema, principalRefSchema, roleSchema, scopeSchema } from '../auth.ts';
import { auditEventIdSchema, keyIdSchema, sessionIdSchema, userIdSchema } from '../ids.ts';
import { jsonObjectSchema } from '../json.ts';
import { labelSchema } from '../names.ts';
import { pageQuerySchema, timestampSchema } from '../primitives.ts';

export const userSchema = z
  .object({
    id: userIdSchema,
    email: z.email(),
    /** What they are called. Null for one who has not said. */
    displayName: labelSchema.nullable(),
    role: roleSchema,
    createdAt: timestampSchema,
    /** Null for one who can sign in. One who is disabled cannot, and their keys do not work. */
    disabledAt: timestampSchema.nullable(),
  })
  .meta({ id: 'User' });
export type User = z.infer<typeof userSchema>;

/** What of a person can be changed. Who may change a role is in `auth.ts`. */
export const updateUserRequestSchema = z
  .strictObject({
    displayName: labelSchema.nullable().optional(),
    role: roleSchema.optional(),
    disabled: z.boolean().optional(),
  })
  .meta({ id: 'UpdateUserRequest' });
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;

/** A person signed in somewhere. */
export const sessionSchema = z
  .object({
    id: sessionIdSchema,
    user: userIdSchema,
    /** What signed in: the dashboard in a browser, or the command. */
    client: z.enum(['dashboard', 'cli']),
    /** A few words on where, such as the browser's name. Null when nothing is known. */
    label: labelSchema.nullable(),
    createdAt: timestampSchema,
    lastUsedAt: timestampSchema.nullable(),
    expiresAt: timestampSchema,
  })
  .meta({ id: 'Session' });
export type Session = z.infer<typeof sessionSchema>;

/** An API key, without its secret: that is shown once, when the key is made. */
export const keySchema = z
  .object({
    id: keyIdSchema,
    label: labelSchema,
    /** The person it belongs to. Null for a service's key, which is nobody's. */
    owner: userIdSchema.nullable(),
    scope: scopeSchema,
    permissions: z.array(permissionSchema),
    /** Null for one that does not expire. */
    expiresAt: timestampSchema.nullable(),
    createdBy: principalRefSchema,
    createdAt: timestampSchema,
    /** Null until a request has come with it. */
    lastUsedAt: timestampSchema.nullable(),
  })
  .meta({ id: 'Key' });
export type Key = z.infer<typeof keySchema>;

/**
 * A key to make. It holds no more than its maker does, and reaches no further. A person's key
 * is theirs unless it is made as a service's.
 */
export const createKeyRequestSchema = z
  .strictObject({
    label: labelSchema,
    scope: scopeSchema,
    permissions: z.array(permissionSchema).min(1),
    expiresAt: timestampSchema.optional(),
    /** A key that is nobody's, and outlasts whoever made it. */
    service: z.boolean().default(false),
  })
  .meta({ id: 'CreateKeyRequest' });
export type CreateKeyRequest = z.infer<typeof createKeyRequestSchema>;

export const createKeyResponseSchema = z
  .object({
    key: keySchema,
    /** The key itself: what a request sends. It is given here and never again. */
    token: z.string().min(1),
  })
  .meta({ id: 'CreateKeyResponse' });
export type CreateKeyResponse = z.infer<typeof createKeyResponseSchema>;

/** Something that was done, and by whom. The log is added to and never changed. */
export const auditEventSchema = z
  .object({
    id: auditEventIdSchema,
    at: timestampSchema,
    by: principalRefSchema,
    /** What was done, as `<thing>.<what>`, such as `key.create`. */
    action: z.string().regex(/^[a-z_]+\.[a-z_]+$/),
    /** What it was done to. Null for what has no one thing, such as signing in. */
    target: z.object({ type: z.string().min(1), id: z.string().min(1) }).nullable(),
    /** What else there is to say of it. Never a secret. */
    detail: jsonObjectSchema.nullable(),
  })
  .meta({ id: 'AuditEvent' });
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const listAuditEventsQuerySchema = pageQuerySchema.extend({
  action: z.string().min(1).optional(),
});
export type ListAuditEventsQuery = z.infer<typeof listAuditEventsQuerySchema>;
