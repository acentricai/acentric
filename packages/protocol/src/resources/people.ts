// People, their sessions, the API keys, and the record of what was done.
//
// How a person signs in is not here: these are what there is once they have.

import { z } from 'zod';

import { permissionSchema, principalRefSchema, roleSchema, scopeSchema } from '../auth.ts';
import {
  auditEventIdSchema,
  inviteIdSchema,
  keyIdSchema,
  sessionIdSchema,
  userIdSchema,
} from '../ids.ts';
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
    /**
     * Which picture of them there is, at `/v1/users/{user}/photo?v=<photo>`: it is another for
     * each picture. Null for one with none.
     */
    photo: z.string().nullable(),
  })
  .meta({ id: 'User' });
export type User = z.infer<typeof userSchema>;

/** The most a picture of a person may be, in bytes. */
export const PHOTO_BYTES = 2 * 1024 * 1024;
/** What a picture of a person may be. */
export const PHOTO_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

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

// Signing in
//
// A person signs in with their email and a password the engine keeps the hash of. The engine
// sends no email: an email is what a person signs in as, and nothing is ever sent to it.
//
// An account is made by a link that is used once. The first is printed by a server that has
// no person yet, and makes its owner. After that an admin makes an invite, and passes its
// link on themselves. A password that was lost is set again the same way.

/** The fewest characters a password is. */
export const PASSWORD_MIN = 10;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN, `A password is ${String(PASSWORD_MIN)} characters or more`)
  .max(1024)
  .meta({ description: 'A password. It is never given back.' });

/** What signs in: the dashboard in a browser, or the command. */
export const sessionClientSchema = z.enum(['dashboard', 'cli']);
export type SessionClient = z.infer<typeof sessionClientSchema>;

/** What a session is for, said when it is made. */
const sessionFor = {
  /** The dashboard's session is kept in a cookie. The command's is given as a token. */
  client: sessionClientSchema.default('dashboard'),
  /** A few words on where, such as the browser's name. */
  label: labelSchema.optional(),
};

/** The token of a link that is used once: what the link ends in. */
const linkTokenSchema = z.string().min(1).max(200);

/** A person, signed in. */
export const signedInSchema = z
  .object({
    user: userSchema,
    session: sessionSchema,
    /**
     * What the command sends with its requests from now on. It is given here and never
     * again. The dashboard has none: its session is in a cookie its scripts cannot read.
     */
    token: z.string().optional(),
  })
  .meta({ id: 'SignedIn' });
export type SignedIn = z.infer<typeof signedInSchema>;

export const signInRequestSchema = z
  .strictObject({ email: z.email(), password: z.string().min(1).max(1024), ...sessionFor })
  .meta({ id: 'SignInRequest' });
export type SignInRequest = z.infer<typeof signInRequestSchema>;

/** The first person of an engine, made by the link the server printed when it had none. */
export const setupRequestSchema = z
  .strictObject({
    token: linkTokenSchema,
    email: z.email(),
    password: passwordSchema,
    displayName: labelSchema.optional(),
    ...sessionFor,
  })
  .meta({ id: 'SetupRequest' });
export type SetupRequest = z.infer<typeof setupRequestSchema>;

/** An invite: a link that makes one account, with a role, when someone opens it. */
export const inviteSchema = z
  .object({
    id: inviteIdSchema,
    role: roleSchema,
    /** Who it was made for, as its maker noted. Whoever opens it gives their own email. */
    note: labelSchema.nullable(),
    createdBy: principalRefSchema,
    createdAt: timestampSchema,
    expiresAt: timestampSchema,
  })
  .meta({ id: 'Invite' });
export type Invite = z.infer<typeof inviteSchema>;

export const createInviteRequestSchema = z
  .strictObject({
    role: roleSchema.default('member'),
    note: labelSchema.optional(),
  })
  .meta({ id: 'CreateInviteRequest' });
export type CreateInviteRequest = z.infer<typeof createInviteRequestSchema>;

export const createInviteResponseSchema = z
  .object({
    invite: inviteSchema,
    /** What the invite's link ends in. It is given here and never again. */
    token: linkTokenSchema,
  })
  .meta({ id: 'CreateInviteResponse' });
export type CreateInviteResponse = z.infer<typeof createInviteResponseSchema>;

export const acceptInviteRequestSchema = z
  .strictObject({
    token: linkTokenSchema,
    email: z.email(),
    password: passwordSchema,
    displayName: labelSchema.optional(),
    ...sessionFor,
  })
  .meta({ id: 'AcceptInviteRequest' });
export type AcceptInviteRequest = z.infer<typeof acceptInviteRequestSchema>;

/** A link that sets a person's password again, made by an admin for one who lost theirs. */
export const passwordResetSchema = z
  .object({
    /** What the link ends in. It is given here and never again. */
    token: linkTokenSchema,
    expiresAt: timestampSchema,
  })
  .meta({ id: 'PasswordReset' });
export type PasswordReset = z.infer<typeof passwordResetSchema>;

export const resetPasswordRequestSchema = z
  .strictObject({ token: linkTokenSchema, password: passwordSchema })
  .meta({ id: 'ResetPasswordRequest' });
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;

/** A person's own change of their password. Everywhere else they are signed in is signed out. */
export const changePasswordRequestSchema = z
  .strictObject({ current: z.string().min(1).max(1024), password: passwordSchema })
  .meta({ id: 'ChangePasswordRequest' });
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

/** What a person changes of themselves. */
export const updateMeRequestSchema = z
  .strictObject({ displayName: labelSchema.nullable() })
  .meta({ id: 'UpdateMeRequest' });
export type UpdateMeRequest = z.infer<typeof updateMeRequestSchema>;

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
