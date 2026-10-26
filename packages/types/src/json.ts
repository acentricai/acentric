// Layer 0: every piece of data in the framework is plain JSON.
//
// State, messages, effect args and handler results must all survive
// JSON.stringify followed by JSON.parse unchanged. That is what lets an
// agent be saved, replayed and tested. Values JSON cannot carry
// (undefined, functions, Date, Map, BigInt, class instances) are not Json.

export type Json = JsonPrimitive | JsonArray | JsonObject;

export type JsonPrimitive = null | boolean | number | string;

/**
 * Readonly, like all of an agent's state, so readonly arrays (as libraries
 * type their JSON) are Json too. A mutable array still is.
 */
export type JsonArray = readonly Json[];

export type JsonObject = { [key: string]: Json };
