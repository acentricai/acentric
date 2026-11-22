// The API's document, in OpenAPI 3.1, made from the route table. Nothing is written by hand:
// a route that changes changes the document, and a test keeps a copy of it in the repository,
// so that a change to the API shows in a review.

import { z } from 'zod';

import { ERROR_STATUS } from './errors.ts';
import type { ErrorCode } from './errors.ts';
import type { JsonObject } from './json.ts';
import { COMMON_ERRORS, pathParams } from './routes.ts';
import type { Route } from './routes.ts';

type Schemas = { [id: string]: JsonObject };

const REF = '#/components/schemas/';

/**
 * Every schema that has a name, described as it is read. Read that way, a field with a default
 * may be left out of a request, a request body refuses a field it does not know, and an answer
 * does not: an answer may gain fields, and a client is to let them by.
 */
function namedSchemas(): Schemas {
  const { schemas } = z.toJSONSchema(z.globalRegistry, { uri: (id) => `${REF}${id}`, io: 'input' });
  return Object.fromEntries(
    Object.keys(schemas)
      .toSorted()
      .map((id) => {
        const { $schema: _dialect, $id: _id, ...rest } = schemas[id] as JsonObject;
        return [id, rest];
      }),
  );
}

/** The name of a schema that has one. A route's body and answer must. */
function nameOf(schema: z.ZodType, what: string): string {
  const id = z.globalRegistry.get(schema)?.id;
  if (id === undefined) throw new Error(`${what} has no name: give its schema an id with .meta()`);
  return id;
}

/** A path's or a query's parameters, one for each field of its schema. */
function parametersOf(
  schema: z.ZodObject | undefined,
  where: 'path' | 'query',
  what: string,
): JsonObject[] {
  if (schema === undefined) return [];
  const { properties = {}, required = [] } = z.toJSONSchema(schema, { io: 'input' }) as {
    properties?: { [name: string]: JsonObject };
    required?: string[];
  };
  return Object.entries(properties).map(([name, property]) => {
    if (JSON.stringify(property).includes('"$ref"')) {
      throw new Error(`${what}: the ${where} parameter ${name} is not a plain value`);
    }
    const { description, ...rest } = property;
    return {
      name,
      in: where,
      required: where === 'path' || required.includes(name),
      ...(description === undefined ? {} : { description }),
      schema: rest,
    };
  });
}

/** The failures a route can answer with, by HTTP status. */
function failuresOf(route: Route): { [status: string]: JsonObject } {
  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of new Set([...COMMON_ERRORS, ...route.errors])) {
    const status = ERROR_STATUS[code];
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  return Object.fromEntries(
    [...byStatus.entries()]
      .toSorted(([a], [b]) => a - b)
      .map(([status, codes]) => [
        String(status),
        {
          description: `Failed: ${codes.join(', ')}.`,
          content: { 'application/json': { schema: { $ref: `${REF}Error` } } },
        },
      ]),
  );
}

function operationOf(id: string, route: Route): JsonObject {
  const answer = (description: string): JsonObject => {
    if (route.stream === true) {
      return {
        description,
        content: { 'text/event-stream': { schema: { $ref: `${REF}ActorEvent` } } },
      };
    }
    if (route.response === undefined) return { description };
    const name = nameOf(route.response, `The answer of ${id}`);
    return { description, content: { 'application/json': { schema: { $ref: `${REF}${name}` } } } };
  };

  return {
    operationId: id,
    summary: route.summary,
    tags: [id.slice(0, id.indexOf('.'))],
    'x-acentric-auth': route.auth,
    // A route that makes a credential is called without one.
    ...(route.auth.on === 'none' ? { security: [] } : {}),
    parameters: [
      ...parametersOf(route.params, 'path', id),
      ...parametersOf(route.query, 'query', id),
    ],
    ...(route.body === undefined
      ? {}
      : {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: `${REF}${nameOf(route.body, `The body of ${id}`)}` },
              },
            },
          },
        }),
    responses: {
      ...(route.existing === undefined ? {} : { '200': answer('It was there already.') }),
      [String(route.status)]: answer(route.stream === true ? 'A stream of events.' : 'Done.'),
      ...failuresOf(route),
    },
  };
}

/** The OpenAPI document of `routes`. */
export function buildOpenApi(
  routes: { readonly [id: string]: Route },
  info: { readonly title: string; readonly version: string },
): JsonObject {
  const schemas = namedSchemas();

  const paths: { [path: string]: { [method: string]: JsonObject } } = {};
  for (const [id, route] of Object.entries(routes)) {
    const declared = Object.keys(route.params?.shape ?? {});
    const inPath = pathParams(route.path);
    if (declared.toSorted().join() !== inPath.toSorted().join()) {
      throw new Error(
        `${id}: the path has ${inPath.join(', ') || 'no parameters'}, and its schema ${declared.join(', ') || 'none'}`,
      );
    }
    const methods = (paths[route.path] ??= {});
    const method = route.method.toLowerCase();
    if (methods[method] !== undefined)
      throw new Error(`${id}: ${route.method} ${route.path} is another route's`);
    methods[method] = operationOf(id, route);
  }

  return {
    openapi: '3.1.0',
    info,
    security: [{ bearer: [] }],
    paths,
    components: {
      securitySchemes: {
        bearer: {
          type: 'http',
          scheme: 'bearer',
          description: 'An API key, or the token of a session.',
        },
      },
      schemas,
    },
  };
}
