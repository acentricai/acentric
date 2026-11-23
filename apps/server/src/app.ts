// The HTTP API: the engine, answered for by the table of routes.
//
// Every route is taken from that table. A request is read by its route's schemas, let through
// by what its route asks of whoever calls, handed to the route's handler, and answered with
// what the handler gives. So the server cannot take or answer what the table does not say,
// and a client that calls by the same table cannot disagree with it.

import { randomBytes } from 'node:crypto';

import {
  API_VERSION,
  COMMAND_HEADER,
  MAX_BUNDLE_SIZE,
  buildOpenApi,
  routes,
} from '@acentric/protocol';
import type { Issue, Route, RouteId } from '@acentric/protocol';
import { Hono } from 'hono';
import type { z } from 'zod';

import { authenticate, authorize } from './auth.ts';
import { serveDashboard } from './dashboard.ts';
import { serveDownloads } from './downloads.ts';
import type { Downloads } from './downloads.ts';
import { ApiFailure, failureOf } from './errors.ts';
import { Reply, handlers } from './handlers.ts';
import type { Parts } from './handlers.ts';

export type AppOptions = Omit<Parts, 'streams'> & {
  readonly streams: Parts['streams'];
  /** What the server says it is, at `/health`. */
  readonly version: string;
  /** Told of what the server itself failed at. `console.error` without it. */
  readonly report?: (error: unknown, requestId: string) => void;
  /**
   * Whether every answer is checked against its route's schema, and one that does not match
   * fails the request. For tests: it holds the server to its own contract.
   */
  readonly checkAnswers?: boolean;
  /** What the server hands out to be installed elsewhere: the command. Nothing, without it. */
  readonly downloads?: Downloads;
  /** The folder of the dashboard's build, which the server serves at every other path. None, without it. */
  readonly dashboard?: string;
};

/** The most a request's body is, in bytes: a deploy's code, and what goes around it. */
const MAX_DEPLOY_BYTES = MAX_BUNDLE_SIZE * 4 + 64 * 1024;
/** The most the body of any other request is. */
const MAX_BODY_BYTES = 1024 * 1024;

const issuesOf = (error: z.ZodError): Issue[] =>
  error.issues.map((issue) => ({
    message: issue.message,
    path: issue.path.map((part) => (typeof part === 'number' ? part : String(part))),
  }));

/** What was given, read by a schema, or a refusal that says what is wrong with it. */
function read<S extends z.ZodType>(schema: S, given: unknown, what: string): z.output<S> {
  const parsed = schema.safeParse(given);
  if (parsed.success) return parsed.data;
  throw new ApiFailure(
    'invalid_request',
    `The ${what} is not what this takes`,
    issuesOf(parsed.error),
  );
}

/** A request's body as JSON, refused when it is longer than it may be or is not JSON. */
async function jsonOf(request: Request, most: number): Promise<unknown> {
  const tooLarge = () =>
    new ApiFailure('too_large', `The request is larger than the ${String(most)} bytes this takes`);
  if (Number(request.headers.get('content-length') ?? 0) > most) throw tooLarge();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request.body ?? []) {
    size += chunk.byteLength;
    if (size > most) throw tooLarge();
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiFailure('invalid_request', 'The body is not JSON');
  }
}

export function createApp(options: AppOptions): Hono {
  const { engine, keys, people } = options;
  const report =
    options.report ??
    ((error: unknown, requestId: string) => {
      console.error(`request ${requestId} failed:`, error);
    });
  const app = new Hono();

  // A server that hands out the command says which one with every answer, so that a command
  // installed from it sees when the server has another version.
  if (options.downloads !== undefined) {
    const downloads = new Hono();
    const command = serveDownloads(downloads, options.downloads);
    app.use('*', async (context, next) => {
      await next();
      context.res.headers.set(COMMAND_HEADER, command);
    });
    app.route('/', downloads);
  }

  // Not of the API: whether the server is up, and what the API is.
  app.get('/health', (context) => context.json({ ok: true, version: options.version }));
  // Whether the process is there, as while it upgrades (see upgrading.ts): what restarts a
  // server that died asks this, and what sends it requests asks /health.
  app.get('/health/live', (context) => context.json({ ok: true, version: options.version }));
  const openApi = buildOpenApi(routes, { title: 'Acentric', version: API_VERSION });
  app.get('/v1/openapi.json', (context) => context.json(openApi));

  for (const [id, route] of Object.entries(routes) as [RouteId, Route][]) {
    const handler = handlers[id] as ((asked: unknown, parts: Parts) => unknown) | undefined;
    // A route of the table that is not built yet is not there.
    if (handler === undefined) continue;
    const path = route.path.replaceAll(/\{([^}]+)\}/g, ':$1');

    app.on(route.method, path, async (context) => {
      const requestId = randomBytes(8).toString('hex');
      const { req } = context;
      try {
        const params = route.params === undefined ? {} : read(route.params, req.param(), 'path');
        // A route that makes a credential is called without one.
        const granted =
          route.auth.on === 'none'
            ? {}
            : await authorize(
                engine,
                await authenticate(keys, people, req.raw),
                route.auth,
                params as never,
              );
        const query =
          route.query === undefined ? undefined : read(route.query, req.query(), 'query');
        const most = id === 'deployments.create' ? MAX_DEPLOY_BYTES : MAX_BODY_BYTES;
        const body =
          route.body === undefined
            ? undefined
            : read(route.body, await jsonOf(req.raw, most), 'body');

        const given = await handler({ ...granted, params, query, body, request: req.raw }, options);
        if (given instanceof Response) return given;
        const answer: unknown = given instanceof Reply ? given.body : given;
        const headers = {
          'x-request-id': requestId,
          ...(given instanceof Reply ? given.headers : {}),
        };
        if (route.response === undefined) {
          return new Response(null, { status: route.status, headers });
        }
        if (options.checkAnswers === true) {
          const checked = route.response.safeParse(answer);
          if (!checked.success) {
            throw new Error(`${id} answered what its route does not: ${checked.error.message}`);
          }
        }
        // A route that makes something unless it is there already says which it was.
        const existed =
          route.existing !== undefined && (answer as { created?: boolean }).created === false;
        return Response.json(answer, { status: existed ? route.existing : route.status, headers });
      } catch (error) {
        const { status, body } = failureOf(error, requestId, report);
        // One who is to wait is told for how long.
        const wait = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs;
        return Response.json(body, {
          status,
          headers: {
            'x-request-id': requestId,
            ...(typeof wait === 'number' ? { 'retry-after': String(Math.ceil(wait / 1000)) } : {}),
          },
        });
      }
    });
  }

  // Last: every GET no route above answered is the dashboard's.
  if (options.dashboard !== undefined) serveDashboard(app, options.dashboard);

  app.notFound(() => {
    const requestId = randomBytes(8).toString('hex');
    const { status, body } = failureOf(
      new ApiFailure('not_found', 'There is no such route'),
      requestId,
      report,
    );
    return Response.json(body, { status });
  });
  app.onError((error) => {
    const requestId = randomBytes(8).toString('hex');
    const { status, body } = failureOf(error, requestId, report);
    return Response.json(body, { status });
  });
  return app;
}
