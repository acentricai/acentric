// The bundle's side of what the engine and an agent's code say to each other (see
// `@acentric/protocol/bundle`). It is in every bundle, since it is part of the framework a
// bundle is built with.
//
// Everything of an agent is checked here as it is read: a bundle may have been written in
// JavaScript, with nothing to hold it to the types.

import { BUNDLE_FILE_PART, BUNDLE_PROTOCOL } from '@acentric/protocol/bundle';
import type {
  BundleContext,
  BundleEntry,
  BundleHost,
  CallIssue,
  CallOutcome,
} from '@acentric/protocol/bundle';
import type { AgentDefinition, Json, JsonObject } from '@acentric/protocol';

import type { AnyAgent } from './agent.ts';
import { SecretNotSet } from './context.ts';

type Dict = { readonly [key: string]: unknown };
type Fn = (...args: never[]) => unknown;

/** The agent's code is not an agent, as far as can be read off it. */
export class InvalidAgent extends Error {
  override readonly name = 'InvalidAgent';
}

/** The engine's own tools, whose names an agent's tool cannot have. */
const RESERVED = ['bash', 'view_image', 'code', 'stop', 'spawn_agent', 'message_agent', 'schedule'];

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const INPUT_TYPE = /^[A-Za-z0-9_.-]{1,64}$/;
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const isDict = (value: unknown): value is Dict =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isFn = (value: unknown): value is Fn => typeof value === 'function';
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A value as JSON, or a throw that says what was not. */
function json(value: unknown, what: string): Json {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error('it is nothing JSON has');
    return JSON.parse(text) as Json;
  } catch (error) {
    throw new Error(`${what} is not JSON: ${messageOf(error)}`, { cause: error });
  }
}

/** The `validate` of a schema, or undefined when the value is not a schema. */
function validateOf(schema: unknown): Fn | undefined {
  if (!isDict(schema) && !isFn(schema)) return undefined;
  const standard = (schema as Dict)['~standard'];
  if (!isDict(standard) || !isFn(standard['validate'])) return undefined;
  return standard['validate'];
}

/** The JSON Schema of what a schema takes, or undefined when it cannot give one. */
function jsonSchemaOf(schema: unknown): JsonObject | undefined {
  const standard = (schema as Dict)['~standard'];
  const converter = isDict(standard) ? standard['jsonSchema'] : undefined;
  if (!isDict(converter) || !isFn(converter['input'])) return undefined;
  const given = (converter['input'] as (options: Dict) => unknown)({ target: 'draft-2020-12' });
  const read = json(given, 'Its JSON Schema');
  return isDict(read) ? (read as JsonObject) : undefined;
}

// Describing

type ToolDeclaration = AgentDefinition['tools'][number];

function describeTool(tool: unknown, index: number, names: Set<string>): ToolDeclaration {
  if (!isDict(tool)) throw new InvalidAgent(`tools[${String(index)}] is not a tool`);
  const { name, description, parameters, codemode, retrySafe, execute } = tool;
  if (typeof name !== 'string' || !TOOL_NAME.test(name)) {
    const given = JSON.stringify(name);
    throw new InvalidAgent(
      `tools[${String(index)}] has the name ${given}: a tool's name is 1 to 64 letters, digits, _ or -`,
    );
  }
  if (RESERVED.includes(name)) {
    throw new InvalidAgent(`A tool is named ${name}, which is one of the engine's own tools`);
  }
  if (names.has(name)) throw new InvalidAgent(`Two tools are named ${name}`);
  names.add(name);
  if (typeof description !== 'string' || description === '') {
    throw new InvalidAgent(`The tool ${name} has no description`);
  }
  if (!isFn(execute)) throw new InvalidAgent(`The tool ${name} has no execute function`);
  for (const [field, value] of [
    ['codemode', codemode],
    ['retrySafe', retrySafe],
  ] as const) {
    if (value !== undefined && typeof value !== 'boolean') {
      throw new InvalidAgent(`${field} of the tool ${name} is true or false`);
    }
  }
  if (validateOf(parameters) === undefined) {
    throw new InvalidAgent(`parameters of the tool ${name} is not a schema`);
  }
  let schema: JsonObject | undefined;
  try {
    schema = jsonSchemaOf(parameters);
  } catch (error) {
    throw new InvalidAgent(
      `The schema of the tool ${name} failed to give its JSON Schema: ${messageOf(error)}`,
    );
  }
  if (schema === undefined) {
    throw new InvalidAgent(
      `The schema of the tool ${name} cannot give its JSON Schema, which the model is sent`,
    );
  }
  if (schema['type'] !== 'object') {
    throw new InvalidAgent(
      `The arguments of the tool ${name} are an object: its schema is not of one`,
    );
  }
  return { name, description, parameters: schema, retrySafe: retrySafe === true };
}

/** What the agent asks of its provider that only that provider has. */
function providerOptionsOf(agent: Dict): JsonObject | undefined {
  const search = agent['webSearch'];
  if (search === undefined) return undefined;
  if (search !== true && !isDict(search)) {
    throw new InvalidAgent('webSearch is true, or the sites it looks at');
  }
  return { webSearch: json(search, 'webSearch') };
}

/** What the agent uses that an engine may not have yet, by name. */
function featuresOf(agent: Dict, tools: readonly unknown[]): string[] {
  const used = (value: unknown): boolean =>
    Array.isArray(value) ? value.length > 0 : isDict(value) && Object.keys(value).length > 0;
  return [
    ...(agent['machine'] === true ? ['machine'] : []),
    ...(used(agent['mcps']) ? ['mcps'] : []),
    ...(used(agent['subagents']) ? ['subagents'] : []),
    ...(agent['schedule'] === undefined ? [] : ['schedule']),
    ...(used(agent['compactionSettings']) ? ['compaction-settings'] : []),
    ...(tools.some((tool) => isDict(tool) && tool['codemode'] === true) ? ['codemode'] : []),
  ];
}

function describe(agent: Dict): AgentDefinition {
  const { provider, instructions, configuration } = agent;
  if (typeof provider !== 'string' || provider === '') {
    throw new InvalidAgent('The agent has no provider');
  }
  if (typeof instructions !== 'string') throw new InvalidAgent('The instructions are not text');
  if (configuration !== undefined && validateOf(configuration) === undefined) {
    throw new InvalidAgent('configuration is not a schema');
  }

  const tools: readonly unknown[] = Array.isArray(agent['tools']) ? agent['tools'] : [];
  const names = new Set<string>();
  // A tool of the model's scripts is not one the model calls, and is not offered to it.
  const offered = tools
    .map((tool, index) => ({ tool, index }))
    .filter(({ tool }) => !(isDict(tool) && tool['codemode'] === true))
    .map(({ tool, index }) => describeTool(tool, index, names));

  const inputs = isDict(agent['inputs']) ? agent['inputs'] : {};
  const declared = Object.entries(inputs).map(([type, input]) => {
    if (!INPUT_TYPE.test(type)) {
      const given = JSON.stringify(type);
      throw new InvalidAgent(
        `An input has the type ${given}: a type is 1 to 64 letters, digits, _, . or -`,
      );
    }
    if (!isDict(input) || validateOf(input['schema']) === undefined) {
      throw new InvalidAgent(`schema of the input ${type} is not a schema`);
    }
    if (!isFn(input['handler']))
      throw new InvalidAgent(`The input ${type} has no handler function`);
    let schema: JsonObject | undefined;
    try {
      schema = jsonSchemaOf(input['schema']);
    } catch {
      // What it takes cannot be said as JSON Schema: it is still checked by its own schema.
    }
    return { type, schema: schema ?? null };
  });

  const secrets: readonly unknown[] = Array.isArray(agent['secrets']) ? agent['secrets'] : [];
  for (const secret of secrets) {
    if (typeof secret !== 'string' || !SECRET_NAME.test(secret)) {
      const given = JSON.stringify(secret);
      throw new InvalidAgent(`A secret is named ${given}: a name is letters, digits and _`);
    }
  }

  let configurationSchema: JsonObject | undefined;
  try {
    configurationSchema = configuration === undefined ? undefined : jsonSchemaOf(configuration);
  } catch {
    // As for an input.
  }
  const schedule = agent['schedule'];
  if (schedule !== undefined && (!isDict(schedule) || !isFn(schedule['handler']))) {
    throw new InvalidAgent("The agent's schedule has no handler");
  }
  const providerOptions = providerOptionsOf(agent);
  const features = featuresOf(agent, tools);
  return {
    provider,
    instructions,
    configuration: configuration === undefined ? null : { schema: configurationSchema ?? null },
    tools: offered,
    inputs: declared,
    ...(providerOptions === undefined ? {} : { providerOptions }),
    ...(secrets.length === 0 ? {} : { secrets: [...new Set(secrets as string[])] }),
    ...(features.length === 0 ? {} : { features }),
  };
}

// Calling

/** What a schema makes of `value`: its output, or the issues it has with it. */
async function validate(
  schema: unknown,
  value: unknown,
): Promise<{ readonly value: unknown } | { readonly issues: CallIssue[] }> {
  const run = validateOf(schema);
  if (run === undefined) throw new Error('It has no schema');
  const result = (await (run as (value: unknown) => unknown)(value)) as Dict;
  if (!Array.isArray(result['issues'])) return { value: result['value'] };
  return {
    issues: (result['issues'] as Dict[]).map((issue) => ({
      message: String(issue['message']),
      ...(Array.isArray(issue['path'])
        ? {
            path: (issue['path'] as unknown[]).map((segment) => {
              const key = isDict(segment) ? segment['key'] : segment;
              return typeof key === 'number' ? key : String(key);
            }),
          }
        : {}),
    })),
  };
}

/** What a tool or a handler returned, checked to be content. */
function content(value: unknown, what: string): Json {
  if (typeof value === 'string') return value;
  // Where an image or a file comes from: a URL, base64 with its media type, a provider's file,
  // or a blob the actor's conversation has already, which the engine checks that it has.
  const isSource = (source: unknown): boolean =>
    isDict(source) &&
    ((source['type'] === 'url' && typeof source['url'] === 'string') ||
      (source['type'] === 'blob' &&
        typeof source['digest'] === 'string' &&
        typeof source['mediaType'] === 'string' &&
        typeof source['size'] === 'number') ||
      (source['type'] === 'base64' &&
        typeof source['mediaType'] === 'string' &&
        typeof source['data'] === 'string') ||
      (source['type'] === 'file_id' && typeof source['id'] === 'string'));
  const isPart = (part: unknown): boolean =>
    isDict(part) &&
    ((part['type'] === 'text' && typeof part['text'] === 'string') ||
      ((part['type'] === 'image' || part['type'] === 'file') && isSource(part['source'])));
  if (!Array.isArray(value) || !value.every(isPart)) {
    throw new Error(`${what} returned what is not content: text, or text, image and file parts`);
  }
  return json(value, 'The content');
}

// Bytes and base64, with what every place an agent's code runs in has: the web platform.

type NativeBase64 = {
  readonly toBase64?: (this: Uint8Array) => string;
};
type NativeFromBase64 = {
  readonly fromBase64?: (text: string) => Uint8Array;
};
/** What the web platform has that the language does not: this package is built with neither's types. */
const web = globalThis as unknown as {
  readonly btoa: (binary: string) => string;
  readonly atob: (base64: string) => string;
  readonly TextEncoder: new () => { encode(text: string): Uint8Array };
  readonly TextDecoder: new (
    label: string,
    options: { readonly ignoreBOM: boolean },
  ) => { decode(bytes: Uint8Array): string };
};

function toBase64(bytes: Uint8Array): string {
  const native = (bytes as NativeBase64).toBase64;
  if (isFn(native)) return native.call(bytes);
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return web.btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const native = (Uint8Array as NativeFromBase64).fromBase64;
  if (isFn(native)) return native(text);
  const binary = web.atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
  return bytes;
}

function pathOf(path: unknown): string {
  if (typeof path !== 'string' || path === '') throw new TypeError("A file's path is a string");
  return path;
}

/**
 * The actor's machine with its files. The functions are not enumerable: the machine as data,
 * such as one a subagent's `create` gives back, is its ID, working directory and variables.
 */
function machineOf(machine: BundleContext['machine'] | undefined, host: BundleHost): Dict | null {
  if (machine === undefined || machine === null) return null;
  // A file moves in as many parts as it takes: nothing large is said to the engine at once.
  const read = async (given: unknown): Promise<Uint8Array> => {
    const path = pathOf(given);
    const parts: Uint8Array[] = [];
    let from = 0;
    for (;;) {
      const part = await host.file({ op: 'read', path, from });
      const bytes = fromBase64(part?.data ?? '');
      parts.push(bytes);
      from += bytes.length;
      if (bytes.length === 0 || from >= (part?.size ?? 0)) break;
    }
    if (parts.length === 1) return parts[0] as Uint8Array;
    const all = new Uint8Array(from);
    let at = 0;
    for (const part of parts) {
      all.set(part, at);
      at += part.length;
    }
    return all;
  };
  const write = async (given: unknown, data: unknown): Promise<void> => {
    const path = pathOf(given);
    if (typeof data !== 'string' && !(data instanceof Uint8Array)) {
      throw new TypeError('What is written is text or bytes');
    }
    const bytes = typeof data === 'string' ? new web.TextEncoder().encode(data) : data;
    // The first part in place of what the file had, and each next one after its end.
    for (let from = 0; ; from += BUNDLE_FILE_PART) {
      const part = toBase64(bytes.subarray(from, from + BUNDLE_FILE_PART));
      await host.file({ op: 'write', path, from, size: bytes.length, data: part });
      if (from + BUNDLE_FILE_PART >= bytes.length) break;
    }
  };
  return Object.freeze(
    Object.defineProperties(
      { ...machine },
      {
        read: { value: read },
        readText: {
          // As the bytes are: a mark at the start that says the order of bytes is kept.
          value: async (path: unknown) =>
            new web.TextDecoder('utf-8', { ignoreBOM: true }).decode(await read(path)),
        },
        write: { value: write },
      },
    ),
  );
}

/** The context an agent's code is given, made from what the engine sent. */
function contextOf(sent: BundleContext, configuration: unknown, host: BundleHost): Dict {
  return {
    agent: sent.agent,
    agentName: sent.agentName,
    actor: sent.actor,
    actorName: sent.actorName,
    externalId: sent.externalId,
    configuration,
    modelId: sent.modelId,
    reasoning: sent.reasoning,
    machine: machineOf(sent.machine, host),
    secrets: {
      get: async (name: string): Promise<string> => {
        const value = await host.secret(name);
        if (value === undefined) throw new SecretNotSet(name);
        return value;
      },
    },
  };
}

async function call(
  agent: Dict,
  path: string,
  argument: Json,
  sent: BundleContext,
  host: BundleHost,
): Promise<{ readonly value: Json } | { readonly issues: CallIssue[] }> {
  const [part, name, member] = path.split('.') as [string, string | undefined, string | undefined];

  if (path === 'configuration.validate') {
    if (agent['configuration'] === undefined) {
      if (argument !== null) throw new Error('The agent takes no configuration');
      return { value: null };
    }
    const checked = await validate(agent['configuration'], argument ?? undefined);
    return 'issues' in checked
      ? checked
      : { value: json(checked.value ?? null, 'The configuration') };
  }

  // What the actor was created with is as its schema returned it then, and is given as it is.
  const context = contextOf(sent, sent.configuration ?? undefined, host);

  if (part === 'tools' && member === 'execute') {
    const tools: readonly unknown[] = Array.isArray(agent['tools']) ? agent['tools'] : [];
    const tool = tools.find((one): one is Dict => isDict(one) && one['name'] === name);
    if (tool === undefined || !isFn(tool['execute']))
      throw new Error(`The agent has no tool ${String(name)}`);
    const checked = await validate(tool['parameters'], argument);
    if ('issues' in checked) return checked;
    const execute = tool['execute'] as (args: unknown, context: Dict) => unknown;
    return { value: content(await execute(checked.value, context), `The tool ${String(name)}`) };
  }

  if (path.startsWith('inputs.') && path.endsWith('.handler')) {
    // A type may have dots in it: it is everything between the first part and the last.
    const type = path.slice('inputs.'.length, -'.handler'.length);
    const inputs = isDict(agent['inputs']) ? agent['inputs'] : {};
    const input = Object.hasOwn(inputs, type) ? inputs[type] : undefined;
    if (!isDict(input) || !isFn(input['handler']))
      throw new Error(`The agent has no input ${type}`);
    const checked = await validate(input['schema'], argument);
    if ('issues' in checked) return checked;
    const handler = input['handler'] as (payload: unknown, context: Dict) => unknown;
    return { value: content(await handler(checked.value, context), `The input ${type}`) };
  }

  if (path === 'schedule.handler') {
    const handler = isDict(agent['schedule']) ? agent['schedule']['handler'] : undefined;
    if (!isFn(handler)) throw new Error('The agent has no schedule handler');
    const fired = argument as {
      readonly note: string;
      readonly dueAt: number;
      readonly firedAt: number;
    };
    const returned = await (handler as (fired: Dict, context: Dict) => unknown)(
      { note: fired.note, dueAt: new Date(fired.dueAt), firedAt: new Date(fired.firedAt) },
      context,
    );
    if (typeof returned !== 'string') throw new Error('it returned what is not text');
    return { value: returned };
  }

  throw new Error(`The agent has nothing at ${path}`);
}

/** The entry of an agent: what its bundle gives the engine. */
export function entryOf(agent: AnyAgent): BundleEntry {
  const read = agent as unknown as Dict;
  return {
    protocol: BUNDLE_PROTOCOL,
    describe: () => describe(read),
    call: async (path, argument, context, host): Promise<CallOutcome> => {
      try {
        const result = await call(read, path, argument, context, host);
        return 'issues' in result
          ? { ok: false, kind: 'invalid', issues: result.issues }
          : { ok: true, value: result.value };
      } catch (error) {
        const name = error instanceof Error ? error.name : 'Error';
        return { ok: false, kind: 'error', error: { name, message: messageOf(error) } };
      }
    },
  };
}
