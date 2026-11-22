// The API's routes, as data: what each takes, what it answers, and what it needs of whoever
// calls it. The server answers requests by this table and the client calls by it, so the two
// cannot disagree. The OpenAPI document is made from it (see `openapi.ts`).
//
// These are the routes of the first milestone. Signing in, machines, sandboxes, model accounts
// and usage are added with the steps that build them.
//
// A path takes IDs and nothing else. What has a name is found by it with a list's `name`.

import { z } from 'zod';

import { principalSchema } from './auth.ts';
import type { Permission } from './auth.ts';
import type { ErrorCode } from './errors.ts';
import {
  actorIdSchema,
  agentIdSchema,
  deploymentIdSchema,
  keyIdSchema,
  sessionIdSchema,
  userIdSchema,
} from './ids.ts';
import { pageQuerySchema, pageSchema } from './primitives.ts';
import {
  actorSchema,
  conversationEntrySchema,
  createActorRequestSchema,
  createActorResponseSchema,
  inputSchema,
  listActorsQuerySchema,
  listInputsQuerySchema,
  listMessagesQuerySchema,
  sendInputRequestSchema,
  sendInputResponseSchema,
  updateActorRequestSchema,
} from './resources/actors.ts';
import {
  agentSchema,
  deployRequestSchema,
  deployResponseSchema,
  deploymentSchema,
  deploymentSummarySchema,
  updateAgentRequestSchema,
  listAgentsQuerySchema,
} from './resources/agents.ts';
import {
  auditEventSchema,
  createKeyRequestSchema,
  createKeyResponseSchema,
  keySchema,
  listAuditEventsQuerySchema,
  sessionSchema,
  updateUserRequestSchema,
  userSchema,
} from './resources/people.ts';

/**
 * What a route needs of whoever calls it.
 *
 *   any     any principal, for what is its own: itself, its sessions.
 *   engine  the permission, across the whole engine.
 *   agent   the permission, on the agent the path parameter `param` names.
 *   actor   the permission, on the actor the path parameter `param` names.
 *   reach   the permission, on whatever the request turns out to be about: a list gives only
 *           what the principal reaches, and a create is refused past its reach.
 */
export type RouteAuth =
  | { readonly on: 'any' }
  | { readonly on: 'engine' | 'reach'; readonly permission: Permission }
  | { readonly on: 'agent' | 'actor'; readonly permission: Permission; readonly param: string };

export type Route = {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** From the root, with each parameter in braces: `/v1/actors/{actor}`. */
  readonly path: string;
  /** What it does, in a line. */
  readonly summary: string;
  readonly auth: RouteAuth;
  /** The path's parameters. */
  readonly params?: z.ZodObject;
  readonly query?: z.ZodObject;
  /** The JSON body. */
  readonly body?: z.ZodType;
  /** What it answers with. Without it, nothing: the status is then 204. */
  readonly response?: z.ZodType;
  /** The status of an answer that is not a failure. */
  readonly status: 200 | 201 | 202 | 204;
  /** For a route that makes something unless it is there already: the status when it was. */
  readonly existing?: 200;
  /** The failures of its own, besides those any route can have (see `COMMON_ERRORS`). */
  readonly errors: readonly ErrorCode[];
  /** For a route whose answer is a stream of server-sent events (see `events.ts`). */
  readonly stream?: true;
};

/** The failures any route can answer with. */
export const COMMON_ERRORS: readonly ErrorCode[] = [
  'invalid_request',
  'unauthenticated',
  'forbidden',
  'rate_limited',
  'internal',
];

const agentParam = z.object({ agent: agentIdSchema });
const actorParam = z.object({ actor: actorIdSchema });

/** A page of `item`, as a schema of its own in the API's document. */
const page = <T extends z.ZodType>(id: string, item: T) => pageSchema(item).meta({ id });

const onAgent = (permission: Permission): RouteAuth => ({
  on: 'agent',
  permission,
  param: 'agent',
});
const onActor = (permission: Permission): RouteAuth => ({
  on: 'actor',
  permission,
  param: 'actor',
});

/** Keeps each route's own types, so that a client is typed by the route it calls. */
function defineRoutes<const T extends { readonly [id: string]: Route }>(routes: T): T {
  return routes;
}

export const routes = defineRoutes({
  'me.get': {
    method: 'GET',
    path: '/v1/me',
    summary: 'Who the request is from, and what it may do.',
    auth: { on: 'any' },
    response: principalSchema,
    status: 200,
    errors: [],
  },

  // Agents and deployments

  'agents.list': {
    method: 'GET',
    path: '/v1/agents',
    summary: 'Lists agents.',
    auth: { on: 'reach', permission: 'agents:read' },
    query: listAgentsQuerySchema,
    response: page('AgentPage', agentSchema),
    status: 200,
    errors: [],
  },
  'agents.get': {
    method: 'GET',
    path: '/v1/agents/{agent}',
    summary: 'Reads an agent.',
    auth: onAgent('agents:read'),
    params: agentParam,
    response: agentSchema,
    status: 200,
    errors: ['not_found'],
  },
  'agents.update': {
    method: 'PATCH',
    path: '/v1/agents/{agent}',
    summary: "Makes one of an agent's deployments the active one.",
    auth: onAgent('agents:deploy'),
    params: agentParam,
    body: updateAgentRequestSchema,
    response: agentSchema,
    status: 200,
    errors: ['not_found'],
  },
  'agents.delete': {
    method: 'DELETE',
    path: '/v1/agents/{agent}',
    summary: 'Deletes an agent, with its deployments and its actors.',
    auth: onAgent('agents:deploy'),
    params: agentParam,
    status: 204,
    errors: ['not_found'],
  },
  'deployments.create': {
    method: 'POST',
    path: '/v1/deployments',
    summary: 'Deploys an agent: its code becomes its newest deployment.',
    auth: { on: 'reach', permission: 'agents:deploy' },
    body: deployRequestSchema,
    response: deployResponseSchema,
    status: 201,
    existing: 200,
    errors: ['unsupported_protocol', 'invalid_agent', 'unsupported_feature', 'too_large'],
  },
  'deployments.list': {
    method: 'GET',
    path: '/v1/agents/{agent}/deployments',
    summary: "Lists an agent's deployments, newest first.",
    auth: onAgent('agents:read'),
    params: agentParam,
    query: pageQuerySchema,
    response: page('DeploymentPage', deploymentSummarySchema),
    status: 200,
    errors: ['not_found'],
  },
  'deployments.get': {
    method: 'GET',
    path: '/v1/agents/{agent}/deployments/{deployment}',
    summary: 'Reads a deployment, with what its code said of itself.',
    auth: onAgent('agents:read'),
    params: z.object({ agent: agentIdSchema, deployment: deploymentIdSchema }),
    response: deploymentSchema,
    status: 200,
    errors: ['not_found'],
  },

  // Actors

  'actors.create': {
    method: 'POST',
    path: '/v1/agents/{agent}/actors',
    summary: 'Creates an actor of an agent, or gives back the one with its external ID.',
    auth: onAgent('actors:write'),
    params: agentParam,
    body: createActorRequestSchema,
    response: createActorResponseSchema,
    status: 201,
    existing: 200,
    errors: ['not_found', 'invalid_configuration', 'name_taken'],
  },
  'actors.list': {
    method: 'GET',
    path: '/v1/actors',
    summary: 'Lists actors, newest first.',
    auth: { on: 'reach', permission: 'actors:read' },
    query: listActorsQuerySchema,
    response: page('ActorPage', actorSchema),
    status: 200,
    errors: [],
  },
  'actors.get': {
    method: 'GET',
    path: '/v1/actors/{actor}',
    summary: 'Reads an actor.',
    auth: onActor('actors:read'),
    params: actorParam,
    response: actorSchema,
    status: 200,
    errors: ['not_found'],
  },
  'actors.update': {
    method: 'PATCH',
    path: '/v1/actors/{actor}',
    summary: 'Changes an actor, between its turns.',
    auth: onActor('actors:write'),
    params: actorParam,
    body: updateActorRequestSchema,
    response: actorSchema,
    status: 200,
    errors: ['not_found', 'actor_busy', 'actor_archived', 'invalid_configuration', 'name_taken'],
  },
  'actors.archive': {
    method: 'POST',
    path: '/v1/actors/{actor}/archive',
    summary: 'Archives an actor: it takes no input until it is unarchived.',
    auth: onActor('actors:write'),
    params: actorParam,
    response: actorSchema,
    status: 200,
    errors: ['not_found'],
  },
  'actors.unarchive': {
    method: 'POST',
    path: '/v1/actors/{actor}/unarchive',
    summary: 'Unarchives an actor.',
    auth: onActor('actors:write'),
    params: actorParam,
    response: actorSchema,
    status: 200,
    errors: ['not_found'],
  },
  'actors.interrupt': {
    method: 'POST',
    path: '/v1/actors/{actor}/interrupt',
    summary: 'Ends the turn an actor is in. What waits in its mailbox stays.',
    auth: onActor('actors:stop'),
    params: actorParam,
    response: actorSchema,
    status: 200,
    errors: ['not_found', 'actor_archived'],
  },
  'actors.retry': {
    method: 'POST',
    path: '/v1/actors/{actor}/retry',
    summary: 'Has an actor whose last turn failed try it again.',
    auth: onActor('actors:stop'),
    params: actorParam,
    response: actorSchema,
    status: 200,
    errors: ['not_found', 'actor_busy', 'actor_archived', 'conflict'],
  },

  // Inputs, the conversation and its events

  'inputs.send': {
    method: 'POST',
    path: '/v1/actors/{actor}/inputs',
    summary:
      'Sends an actor an input. It is answered once the input is stored, not once it is read.',
    auth: onActor('actors:send'),
    params: actorParam,
    body: sendInputRequestSchema,
    response: sendInputResponseSchema,
    status: 202,
    errors: ['not_found', 'actor_archived', 'unknown_input', 'invalid_input'],
  },
  'inputs.list': {
    method: 'GET',
    path: '/v1/actors/{actor}/inputs',
    summary:
      'Lists what an actor was sent, newest first: what waits in its mailbox, and what a turn took.',
    auth: onActor('actors:read'),
    params: actorParam,
    query: listInputsQuerySchema,
    response: page('InputPage', inputSchema),
    status: 200,
    errors: ['not_found'],
  },
  'messages.list': {
    method: 'GET',
    path: '/v1/actors/{actor}/messages',
    summary: "Reads a part of an actor's conversation.",
    auth: onActor('actors:read'),
    params: actorParam,
    query: listMessagesQuerySchema,
    response: page('ConversationPage', conversationEntrySchema),
    status: 200,
    errors: ['not_found'],
  },
  'events.stream': {
    method: 'GET',
    path: '/v1/actors/{actor}/events',
    summary: 'Follows an actor: its conversation as it grows, and where it stands.',
    auth: onActor('actors:read'),
    params: actorParam,
    query: z.object({
      /** Only messages after this place in the conversation. The `Last-Event-ID` header says the same. */
      after: z.coerce.number().int().nonnegative().optional(),
    }),
    status: 200,
    errors: ['not_found'],
    stream: true,
  },

  // People, sessions and keys

  'users.list': {
    method: 'GET',
    path: '/v1/users',
    summary: 'Lists the people of this engine.',
    auth: { on: 'engine', permission: 'users:manage' },
    query: pageQuerySchema,
    response: page('UserPage', userSchema),
    status: 200,
    errors: [],
  },
  'users.get': {
    method: 'GET',
    path: '/v1/users/{user}',
    summary: 'Reads a person.',
    auth: { on: 'engine', permission: 'users:manage' },
    params: z.object({ user: userIdSchema }),
    response: userSchema,
    status: 200,
    errors: ['not_found'],
  },
  'users.update': {
    method: 'PATCH',
    path: '/v1/users/{user}',
    summary: "Changes a person's name or role, or whether they can sign in.",
    auth: { on: 'engine', permission: 'users:manage' },
    params: z.object({ user: userIdSchema }),
    body: updateUserRequestSchema,
    response: userSchema,
    status: 200,
    errors: ['not_found', 'conflict'],
  },
  'users.delete': {
    method: 'DELETE',
    path: '/v1/users/{user}',
    summary: 'Removes a person, with their sessions and their keys.',
    auth: { on: 'engine', permission: 'users:manage' },
    params: z.object({ user: userIdSchema }),
    status: 204,
    errors: ['not_found', 'conflict'],
  },
  'sessions.list': {
    method: 'GET',
    path: '/v1/sessions',
    summary: 'Lists where the person is signed in.',
    auth: { on: 'any' },
    query: pageQuerySchema,
    response: page('SessionPage', sessionSchema),
    status: 200,
    errors: [],
  },
  'sessions.revoke': {
    method: 'DELETE',
    path: '/v1/sessions/{session}',
    summary: "Signs out one of the person's sessions.",
    auth: { on: 'any' },
    params: z.object({ session: sessionIdSchema }),
    status: 204,
    errors: ['not_found'],
  },
  'keys.create': {
    method: 'POST',
    path: '/v1/keys',
    summary: 'Makes an API key. Its token is in the answer, and nowhere after.',
    auth: { on: 'reach', permission: 'keys:manage' },
    body: createKeyRequestSchema,
    response: createKeyResponseSchema,
    status: 201,
    errors: [],
  },
  'keys.list': {
    method: 'GET',
    path: '/v1/keys',
    summary: 'Lists API keys.',
    auth: { on: 'reach', permission: 'keys:manage' },
    query: pageQuerySchema,
    response: page('KeyPage', keySchema),
    status: 200,
    errors: [],
  },
  'keys.get': {
    method: 'GET',
    path: '/v1/keys/{key}',
    summary: 'Reads an API key, without its token.',
    auth: { on: 'reach', permission: 'keys:manage' },
    params: z.object({ key: keyIdSchema }),
    response: keySchema,
    status: 200,
    errors: ['not_found'],
  },
  'keys.revoke': {
    method: 'DELETE',
    path: '/v1/keys/{key}',
    summary: 'Revokes an API key, and every key it made.',
    auth: { on: 'reach', permission: 'keys:manage' },
    params: z.object({ key: keyIdSchema }),
    status: 204,
    errors: ['not_found'],
  },
  'audit.list': {
    method: 'GET',
    path: '/v1/audit-events',
    summary: 'Reads the record of what was done, newest first.',
    auth: { on: 'engine', permission: 'audit:read' },
    query: listAuditEventsQuerySchema,
    response: page('AuditEventPage', auditEventSchema),
    status: 200,
    errors: [],
  },
});

export type RouteId = keyof typeof routes;

type SchemaOf<
  I extends RouteId,
  K extends 'params' | 'query' | 'body' | 'response',
> = (typeof routes)[I] extends { readonly [P in K]: infer S extends z.ZodType } ? S : never;

/** What a caller of route `I` gives for its path's parameters. */
export type ParamsOf<I extends RouteId> = z.input<SchemaOf<I, 'params'>>;
/** What a caller of route `I` may give in its query. */
export type QueryOf<I extends RouteId> = z.input<SchemaOf<I, 'query'>>;
/** What a caller of route `I` sends as its body. */
export type BodyOf<I extends RouteId> = z.input<SchemaOf<I, 'body'>>;
/** What route `I` answers with. */
export type ResponseOf<I extends RouteId> = z.output<SchemaOf<I, 'response'>>;

/** The names of a path's parameters, in the order they come. */
export function pathParams(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] as string);
}

/** A route's path with its parameters put in. */
export function fillPath(path: string, params: { readonly [name: string]: string } = {}): string {
  return path.replaceAll(/\{([^}]+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`The path ${path} takes ${name}, which was not given`);
    return encodeURIComponent(value);
  });
}
