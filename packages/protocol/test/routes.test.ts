import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { HOLDABLE } from '../src/auth.ts';
import { ERROR_CODES } from '../src/errors.ts';
import { actorEventSchema, fromSse, toSse } from '../src/events.ts';
import type { ActorEvent } from '../src/events.ts';
import { makeId } from '../src/ids.ts';
import type { JsonObject } from '../src/json.ts';
import { buildOpenApi } from '../src/openapi.ts';
import { COMMON_ERRORS, fillPath, pathParams, routes } from '../src/routes.ts';
import type { BodyOf, ParamsOf, ResponseOf, Route } from '../src/routes.ts';
import { API_VERSION } from '../src/versions.ts';

const all = Object.entries(routes) as [string, Route][];

describe('the route table', () => {
  it('has every route under the API version, with parameters its schema names', () => {
    for (const [id, route] of all) {
      expect(route.path.startsWith(`/${API_VERSION}/`), id).toBe(true);
      expect(pathParams(route.path).toSorted(), id).toEqual(
        Object.keys(route.params?.shape ?? {}).toSorted(),
      );
    }
  });

  it('has no two routes of one method and path', () => {
    const seen = all.map(([, route]) => `${route.method} ${route.path}`);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('takes an ID for every path parameter, never a name', () => {
    for (const [id, route] of all) {
      for (const [name, schema] of Object.entries(route.params?.shape ?? {})) {
        expect((schema as z.ZodType).safeParse('support').success, `${id} ${name}`).toBe(false);
      }
    }
  });

  it('asks a permission that a key reaching what it is on could hold', () => {
    const asking = all.flatMap(([id, route]) =>
      route.auth.on === 'any' ? [] : [{ id, auth: route.auth }],
    );
    for (const { id, auth } of asking) {
      // What is on one agent, or on one of its actors, a key of that agent can be let do. A key
      // of one actor is let do less on it than that: it is what a client is handed.
      const widest = auth.on === 'agent' || auth.on === 'actor' ? 'agent' : 'engine';
      expect(HOLDABLE[widest], id).toContain(auth.permission);
    }
  });

  it('is on an agent or an actor that its path names', () => {
    const scoped = all.flatMap(([id, route]) =>
      route.auth.on === 'agent' || route.auth.on === 'actor'
        ? [{ id, param: route.auth.param, path: route.path }]
        : [],
    );
    expect(scoped.length).toBeGreaterThan(0);
    for (const { id, param, path } of scoped) expect(pathParams(path), id).toContain(param);
  });

  it('answers 204 exactly when it answers with nothing', () => {
    for (const [id, route] of all) {
      const nothing = route.response === undefined && route.stream !== true;
      expect(route.status === 204, id).toBe(nothing);
    }
  });

  it('lists only failures of its own, each a known code', () => {
    for (const [id, route] of all) {
      for (const code of route.errors) {
        expect(ERROR_CODES, id).toContain(code);
        expect(COMMON_ERRORS, `${id} lists ${code}, which any route can have`).not.toContain(code);
      }
    }
  });

  it('types a call by its route', () => {
    const agent = makeId('agent', { now: 1, random: new Uint8Array(10) });
    const params: ParamsOf<'actors.create'> = { agent };
    const body: BodyOf<'actors.create'> = { externalId: 'telegram:4411' };
    // @ts-expect-error An actor is not created with an ID.
    const wrong: BodyOf<'actors.create'> = { id: 'mine' };
    const created = { created: true } as ResponseOf<'actors.create'>;
    expect([params.agent, body.externalId, wrong, created.created]).toHaveLength(4);
  });
});

describe('fillPath', () => {
  it('puts the parameters in, encoded', () => {
    expect(fillPath('/v1/actors/{actor}/inputs', { actor: 'act_1' })).toBe(
      '/v1/actors/act_1/inputs',
    );
    expect(fillPath('/v1/x/{a}/{b}', { a: 'one/two', b: 'ü' })).toBe('/v1/x/one%2Ftwo/%C3%BC');
    expect(fillPath('/v1/me')).toBe('/v1/me');
  });

  it('refuses a path whose parameter was not given', () => {
    expect(() => fillPath('/v1/actors/{actor}', {})).toThrow(/takes actor/);
  });
});

describe('events', () => {
  const entry = {
    seq: 7,
    message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] },
    createdAt: 1_795_305_600_000,
  };
  const events: ActorEvent[] = [
    { type: 'message', entry },
    { type: 'status', status: 'working', lastTurn: null, pendingInputs: 0 },
    { type: 'delta', answer: 'a1', part: 0, kind: 'text', text: 'Hel' },
    { type: 'delta', answer: 'a1', part: 0, kind: 'text', text: 'Hello, wor', snapshot: true },
  ];

  it('go out as server-sent events and come back the same', () => {
    for (const event of events) {
      const frame = toSse(event);
      expect(frame.event).toBe(event.type);
      expect(fromSse(frame)).toEqual(event);
    }
  });

  it('only a message has an ID: its place in the conversation', () => {
    expect(events.map((event) => toSse(event).id)).toEqual(['7', undefined, undefined, undefined]);
  });

  it('refuse what is not an event', () => {
    expect(() => fromSse({ data: '{"type":"ping"}' })).toThrow(/Invalid discriminator value/);
    expect(
      actorEventSchema.safeParse({ type: 'delta', answer: 'a1', part: 0, kind: 'audio', text: '' })
        .success,
    ).toBe(false);
  });
});

describe('the OpenAPI document', () => {
  const document = buildOpenApi(routes, { title: 'Acentric', version: API_VERSION });
  const text = JSON.stringify(document, null, 2);

  it('has every route', () => {
    const operations = Object.values(document['paths'] as { [path: string]: JsonObject }).flatMap(
      (methods) => Object.values(methods) as JsonObject[],
    );
    expect(operations.map((operation) => operation['operationId']).toSorted()).toEqual(
      Object.keys(routes).toSorted(),
    );
  });

  it('points only at schemas it has', () => {
    const { schemas } = document['components'] as { schemas: { [id: string]: JsonObject } };
    const pointed = [...text.matchAll(/"\$ref": "([^"]+)"/g)].map((match) => match[1] as string);
    expect(pointed.length).toBeGreaterThan(0);
    for (const ref of pointed) {
      expect(ref.startsWith('#/components/schemas/'), ref).toBe(true);
      expect(Object.keys(schemas), ref).toContain(ref.slice('#/components/schemas/'.length));
    }
  });

  it('lets a request leave out a field that has a default, and refuses one it does not know', () => {
    const { schemas } = document['components'] as {
      schemas: { [id: string]: { required?: string[]; additionalProperties?: boolean } };
    };
    expect(schemas['CreateKeyRequest']?.required).not.toContain('service');
    expect(schemas['SendInputRequest']?.required).toEqual(['type']);
    expect(schemas['CreateActorRequest']?.additionalProperties).toBe(false);
  });

  it('lets an answer gain fields: a client is to let by what it does not know', () => {
    const { schemas } = document['components'] as {
      schemas: { [id: string]: { required?: string[]; additionalProperties?: boolean } };
    };
    expect(schemas['Actor']?.required).toContain('pendingInputs');
    expect(schemas['Actor']?.additionalProperties).toBeUndefined();
    expect(schemas['Agent']?.additionalProperties).toBeUndefined();
  });

  it('is the one kept in the repository: run `pnpm vitest run -u` when the API was meant to change', async () => {
    await expect(`${text}\n`).toMatchFileSnapshot('../openapi.json');
  });
});
