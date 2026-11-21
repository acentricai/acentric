// Everything that crosses the API, an event stream or the line to an agent's code is plain
// JSON: it survives JSON.stringify followed by JSON.parse unchanged.

import { z } from 'zod';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type JsonObject = { [key: string]: Json };

/** Any JSON value. Numbers are finite: JSON has no other kind. */
export const jsonSchema: z.ZodType<Json> = z
  .lazy(() =>
    z.union([
      z.null(),
      z.boolean(),
      z.number(),
      z.string(),
      z.array(jsonSchema),
      z.record(z.string(), jsonSchema),
    ]),
  )
  .meta({ id: 'Json', description: 'Any JSON value.' });

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonSchema);
