// Everything that crosses the API, an event stream or the line to an agent's code is plain
// JSON: it survives JSON.stringify followed by JSON.parse unchanged.

import { z } from 'zod';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type JsonObject = { [key: string]: Json };

export const jsonSchema: z.ZodType<Json> = z.json();

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonSchema);
