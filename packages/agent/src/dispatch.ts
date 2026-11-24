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
const RESERVED = ['bash', 'code', 'stop', 'spawn_agent', 'message_agent', 'schedule'];

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
  return {
    name,
    description,
    parameters: schema,
    retrySafe: retrySafe === true,
    ...(codemode === true ? { codemode: true } : {}),
  };
}

/** An agent's own compaction numbers, checked: whole numbers of tokens, by model. */
function describeCompaction(settings: unknown): AgentDefinition['compactionSettings'] {
  if (settings === undefined) return undefined;
  if (!isDict(settings)) {
    throw new InvalidAgent('compactionSettings is an object of numbers by model ID');
  }
  const described: { [model: string]: { threshold?: number; reserve?: number } } = {};
  for (const [model, numbers] of Object.entries(settings)) {
    if (!isDict(numbers)) {
      throw new InvalidAgent(`compactionSettings.${model} is an object with threshold and reserve`);
    }
    const { threshold, reserve, ...rest } = numbers;
    const other = Object.keys(rest)[0];
    if (other !== undefined) {
      throw new InvalidAgent(
        `compactionSettings.${model} has ${other}: it has threshold and reserve`,
      );
    }
    for (const [field, value] of [
      ['threshold', threshold],
      ['reserve', reserve],
    ] as const) {
      if (value !== undefined && !(Number.isInteger(value) && (value as number) >= 0)) {
        throw new InvalidAgent(
          `compactionSettings.${model}.${field} is a whole number of tokens, 0 or more`,
        );
      }
    }
    described[model] = {
      ...(threshold === undefined ? {} : { threshold: threshold as number }),
      ...(reserve === undefined ? {} : { reserve: reserve as number }),
    };
  }
  return Object.keys(described).length === 0 ? undefined : described;
}

type SubagentDeclaration = NonNullable<AgentDefinition['subagents']>[number];

function describeSubagent(subagent: unknown, index: number, ids: Set<string>): SubagentDeclaration {
  if (!isDict(subagent)) throw new InvalidAgent(`subagents[${String(index)}] is not a subagent`);
  const { id, description, params } = subagent;
  if (typeof id !== 'string' || id === '') {
    throw new InvalidAgent(`subagents[${String(index)}] has no id`);
  }
  if (ids.has(id)) throw new InvalidAgent(`The subagent ${id} is listed twice`);
  ids.add(id);
  if (typeof description !== 'string' || description === '') {
    throw new InvalidAgent(`The subagent ${id} has no description`);
  }
  if (params === undefined) return { agent: id, description, creates: false };
  if (!isDict(params)) throw new InvalidAgent(`params of the subagent ${id} is not an object`);
  const { schema, create } = params;
  if (!isFn(create)) throw new InvalidAgent(`params of the subagent ${id} has no create function`);
  if (schema === undefined) return { agent: id, description, creates: true };
  if (validateOf(schema) === undefined) {
    throw new InvalidAgent(`params.schema of the subagent ${id} is not a schema`);
  }
  let told: JsonObject | undefined;
  try {
    told = jsonSchemaOf(schema);
  } catch (error) {
    throw new InvalidAgent(
      `params.schema of the subagent ${id} failed to give its JSON Schema: ${messageOf(error)}`,
    );
  }
  if (told === undefined) {
    throw new InvalidAgent(
      `params.schema of the subagent ${id} cannot give its JSON Schema, which the model is told`,
    );
  }
  if (told['type'] !== 'object') {
    throw new InvalidAgent(
      `What a subagent is spawned with is an object: params.schema of ${id} is not of one`,
    );
  }
  return { agent: id, description, creates: true, schema: told };
}

const REASONING = ['low', 'medium', 'high', 'xhigh', 'max'];

/** What is wrong with a value that is to be a subagent's machine, when something is. */
function machineProblem(value: unknown): string | undefined {
  if (!isDict(value)) return 'machine is an object with id and cwd';
  const { id, cwd, env, ...rest } = value;
  const unknown = Object.keys(rest)[0];
  if (unknown !== undefined) return `machine has no field ${unknown}`;
  if (typeof id !== 'string' || id === '') return 'machine.id is the ID of a machine';
  if (typeof cwd !== 'string' || !(cwd.startsWith('/') || cwd === '~' || cwd.startsWith('~/'))) {
    return 'machine.cwd is a path on the machine that starts with / or ~';
  }
  if (env !== undefined) {
    if (!isDict(env)) return 'machine.env is variables by name, such as { "X_API_KEY": "..." }';
    for (const [name, text] of Object.entries(env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        return `machine.${JSON.stringify(name)} is not a variable's name: letters, digits and _, not starting with a digit`;
      }
      if (typeof text !== 'string') return `machine.env.${name} is a string`;
    }
  }
  return undefined;
}

type McpDeclaration = NonNullable<AgentDefinition['mcps']>[number];

/** The agent's MCP servers, checked: a name a script can say, and a URL the engine can reach. */
function describeMcps(mcps: unknown): McpDeclaration[] {
  if (mcps === undefined) return [];
  if (!isDict(mcps)) throw new InvalidAgent("The agent's mcps are not an object");
  return Object.entries(mcps).map(([name, server]) => {
    if (!TOOL_NAME.test(name)) {
      const given = JSON.stringify(name);
      throw new InvalidAgent(
        `An MCP server is named ${given}: a name is 1 to 64 letters, digits, _ or -`,
      );
    }
    if (!isDict(server) || typeof server['url'] !== 'string') {
      throw new InvalidAgent(`The MCP server ${name} has no url`);
    }
    let protocol: string;
    try {
      ({ protocol } = new web.URL(server['url']));
    } catch {
      throw new InvalidAgent(`The url of the MCP server ${name} is not a URL`);
    }
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw new InvalidAgent(`The url of the MCP server ${name} is not an http or https URL`);
    }
    const { headers, description } = server;
    if (
      headers !== undefined &&
      !isFn(headers) &&
      (!isDict(headers) || Object.values(headers).some((value) => typeof value !== 'string'))
    ) {
      throw new InvalidAgent(
        `headers of the MCP server ${name} is an object of strings, or a function`,
      );
    }
    if (description !== undefined && typeof description !== 'string') {
      throw new InvalidAgent(`description of the MCP server ${name} is a string`);
    }
    return {
      name,
      url: server['url'],
      ...(description === undefined || description === '' ? {} : { description }),
    };
  });
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
    ...(isFn(agent['instructions']) ? ['actor-instructions'] : []),
  ];
}

function describe(agent: Dict): AgentDefinition {
  const { provider, instructions, configuration } = agent;
  if (typeof provider !== 'string' || provider === '') {
    throw new InvalidAgent('The agent has no provider');
  }
  if (typeof instructions !== 'string' && !isFn(instructions)) {
    throw new InvalidAgent('The instructions are not text, nor a function that makes them');
  }
  if (configuration !== undefined && validateOf(configuration) === undefined) {
    throw new InvalidAgent('configuration is not a schema');
  }

  const tools: readonly unknown[] = Array.isArray(agent['tools']) ? agent['tools'] : [];
  const names = new Set<string>();
  // A tool of the model's scripts is said to be one: the model is not offered it.
  const described = tools.map((tool, index) => describeTool(tool, index, names));

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
  const listed: readonly unknown[] = Array.isArray(agent['subagents']) ? agent['subagents'] : [];
  const ids = new Set<string>();
  const subagents = listed.map((subagent, index) => describeSubagent(subagent, index, ids));

  const compactionSettings = describeCompaction(agent['compactionSettings']);
  const mcps = describeMcps(agent['mcps']);

  const schedule = agent['schedule'];
  if (schedule !== undefined && (!isDict(schedule) || !isFn(schedule['handler']))) {
    throw new InvalidAgent("The agent's schedule has no handler");
  }
  const providerOptions = providerOptionsOf(agent);
  const features = featuresOf(agent, tools);
  return {
    provider,
    // Made for each actor, by the agent's code, when there is one: `features` says so.
    instructions: typeof instructions === 'string' ? instructions : '',
    configuration: configuration === undefined ? null : { schema: configurationSchema ?? null },
    tools: described,
    inputs: declared,
    ...(providerOptions === undefined ? {} : { providerOptions }),
    ...(mcps.length === 0 ? {} : { mcps }),
    ...(subagents.length === 0 ? {} : { subagents }),
    ...(compactionSettings === undefined ? {} : { compactionSettings }),
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
  readonly URL: new (url: string) => { readonly protocol: string };
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

  if (path === 'instructions.make') {
    const make = agent['instructions'];
    if (!isFn(make)) throw new Error('The agent has no function that makes its instructions');
    // What the actor was created with, and where it works: nothing to wait for, and no secret.
    const made = (make as (context: Dict) => unknown)(
      Object.freeze({
        agent: sent.agent,
        agentName: sent.agentName,
        actor: sent.actor,
        actorName: sent.actorName,
        externalId: sent.externalId,
        configuration: sent.configuration ?? undefined,
        modelId: sent.modelId,
        reasoning: sent.reasoning,
        machine:
          sent.machine === null
            ? null
            : Object.freeze({ id: sent.machine.id, cwd: sent.machine.cwd }),
      }),
    );
    if (isDict(made) && isFn(made['then'])) {
      throw new Error(
        'it returned a promise: instructions are made at once, by a function that is not async',
      );
    }
    if (typeof made !== 'string') throw new Error('it returned what is not text');
    return { value: made };
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

  if (part === 'subagents' && path.endsWith('.create')) {
    // An agent's name may have dots in it: it is everything between the first part and the last.
    const id = path.slice('subagents.'.length, -'.create'.length);
    const listed: readonly unknown[] = Array.isArray(agent['subagents']) ? agent['subagents'] : [];
    const subagent = listed.find((one): one is Dict => isDict(one) && one['id'] === id);
    if (subagent === undefined) throw new Error(`The agent has no subagent ${id}`);
    const params = isDict(subagent['params']) ? subagent['params'] : undefined;
    const given: unknown = argument ?? {};
    // One with no schema is given nothing by the model.
    if (params?.['schema'] === undefined) {
      if (isDict(given) && Object.keys(given).length > 0) {
        return { issues: [{ message: `${id} takes no params` }] };
      }
      if (params === undefined) return { value: {} };
    }
    let args: unknown;
    if (params['schema'] !== undefined) {
      const checked = await validate(params['schema'], given);
      if ('issues' in checked) return checked;
      args = checked.value;
    }
    const made = await (params['create'] as (args: unknown, context: Dict) => unknown)(
      args,
      context,
    );
    if (!isDict(made)) throw new Error(`create of the subagent ${id} did not return an object`);
    const { machine, modelId, reasoning, configuration, ...rest } = made;
    const unknown = Object.keys(rest)[0];
    if (unknown !== undefined) {
      throw new Error(
        `create of the subagent ${id} returned ${unknown}, which an actor is not created with`,
      );
    }
    if (machine !== undefined && machine !== null) {
      const wrong = machineProblem(machine);
      if (wrong !== undefined) throw new Error(`create of the subagent ${id}: ${wrong}`);
    }
    if (modelId !== undefined && (typeof modelId !== 'string' || modelId === '')) {
      throw new Error(`create of the subagent ${id}: modelId is a string`);
    }
    if (reasoning !== undefined && !REASONING.includes(reasoning as string)) {
      throw new Error(`create of the subagent ${id}: reasoning is one of ${REASONING.join(', ')}`);
    }
    return {
      value: {
        ...(machine === undefined ? {} : { machine: json(machine, 'The machine') }),
        ...(modelId === undefined ? {} : { modelId }),
        ...(reasoning === undefined ? {} : { reasoning: reasoning as string }),
        ...(configuration === undefined
          ? {}
          : { configuration: json(configuration, `The configuration create of ${id} returned`) }),
      },
    };
  }

  if (part === 'mcps' && member === 'headers') {
    const servers = isDict(agent['mcps']) ? agent['mcps'] : {};
    const server = name !== undefined && Object.hasOwn(servers, name) ? servers[name] : undefined;
    if (!isDict(server)) throw new Error(`The agent has no MCP server ${String(name)}`);
    const { headers } = server;
    const made = isFn(headers)
      ? await (headers as (context: Dict) => unknown)(context)
      : (headers ?? {});
    if (!isDict(made) || Object.values(made).some((value) => typeof value !== 'string')) {
      throw new Error(
        `headers of the MCP server ${String(name)} did not return an object of strings`,
      );
    }
    return { value: json(made, 'The headers') };
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
