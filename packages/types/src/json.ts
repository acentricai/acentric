// Layer 0: every piece of data in the framework is plain JSON.
//
// State, messages, effect args and handler results must all survive
// JSON.stringify followed by JSON.parse unchanged. That is what lets an
// agent be saved, replayed and tested. Values JSON cannot carry
// (undefined, functions, Date, Map, BigInt, class instances) are not Json.

export type Json = JsonPrimitive | JsonArray | JsonObject;

export type JsonPrimitive = null | boolean | number | string;

export type JsonArray = Json[];

export type JsonObject = { [key: string]: Json };
