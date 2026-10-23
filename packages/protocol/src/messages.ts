// The protocol's messages: what an application asks a runner, what the
// runner tells it, and what it asks an application that provides handlers.
// JSON-RPC 2.0, one message per line on stdio or one per WebSocket frame.
//
// A rejection or a failed step is a normal result, an `Answer`. JSON-RPC
// errors are for problems with the request itself: an unknown instance, bad
// params, an agent that is not deployed. Their `data.code` names the problem.

import type { Json, JsonObject, LogEntry, Mode } from '@acentric/types';

export const PROTOCOL_VERSION = 1;

export type AgentRef = { name: string; version: string };

/** What a caller is told about a create, input, config change or upgrade. */
export type Answer = { accepted: true } | { rejected: Json } | { failed: Json };

export type Status = 'idle' | 'busy' | 'faulted';

export type RunningEffect = {
  key: string;
  kind: string;
  args: Json;
  attempt: number;
  abort: boolean;
  /** Whether a handler is executing it now, as opposed to waiting for a timer or a provider. */
  active: boolean;
};

export type InstanceInfo = {
  id: string;
  agent: AgentRef;
  status: Status;
  fault: string | null;
  view: Json;
  nextSeq: number;
  running: RunningEffect[];
  /** Whether a job is running or waiting in the instance's mailbox. */
  working: boolean;
  /** The agent's snapshot, when asked for: for debugging, since callers otherwise see the view. */
  snapshot?: JsonObject;
};

export type InstanceListing = {
  id: string;
  agent: AgentRef;
  status: Status;
  fault: string | null;
  nextSeq: number;
  running: number;
  createdAt: number;
};

/** A kind's settings, for kinds an application provides. */
export type KindSettings = { mode: Mode; timeoutMs?: number; maxAttempts?: number };

/**
 * An agent's code: each module as source, or as a path the runner reads.
 * `provides` names kinds an application will provide, with their settings.
 */
export type DeployParams = AgentRef & {
  agent?: string;
  agentPath?: string;
  handlers?: string;
  handlersPath?: string;
  provides?: Record<string, KindSettings>;
};

export type LogParams = {
  id: string;
  after?: number;
  before?: number;
  kinds?: string[];
  limit?: number;
  cursor?: string;
};

export type LogPageResult = { entries: LogEntry[]; cursor?: string };

type Empty = Record<string, never>;

/** Requests an application sends the runner: each method's params and result. */
export type RunnerMethods = {
  initialize: {
    params: { client: string; protocolVersion: number; provides?: string[] };
    result: { runner: string; protocolVersion: number };
  };
  'secrets/set': { params: { name: string; value: string }; result: Empty };
  'agents/deploy': { params: DeployParams; result: { hash: string; deployed: boolean } };
  'agents/list': {
    params: Empty;
    result: { agents: (AgentRef & { hash: string; instances: number })[] };
  };
  'instances/create': {
    params: { agent: AgentRef; config: JsonObject; id?: string };
    result: Answer & { id?: string };
  };
  'instances/input': {
    params: { id: string; input: { id?: string; kind: string; payload: JsonObject } };
    result: Answer;
  };
  'instances/configure': {
    params: { id: string; config: JsonObject; requestId?: string };
    result: Answer;
  };
  'instances/upgrade': { params: { id: string; to: string }; result: Answer };
  'instances/get': { params: { id: string; snapshot?: boolean }; result: InstanceInfo };
  'instances/list': {
    params: { agent?: string; faulted?: boolean; after?: string; limit?: number };
    result: { instances: InstanceListing[] };
  };
  'instances/log': { params: LogParams; result: LogPageResult };
  'instances/delete': { params: { id: string }; result: Empty };
  /**
   * Starts notifications for an instance under a subscription id the client
   * chooses: first the log after `after`, from the store, then each step.
   */
  'instances/subscribe': {
    params: { id: string; subscription: string; after?: number; emits?: boolean };
    result: Empty;
  };
  'instances/unsubscribe': { params: { subscription: string }; result: Empty };
};

/** Notifications the runner sends an application. */
export type RunnerNotifications = {
  log: { subscription: string; id: string; entries: LogEntry[] };
  view: { subscription: string; id: string; view: Json };
  status: { subscription: string; id: string; status: Status; fault: string | null };
  emit: { subscription: string; id: string; key: string; delta: Json };
  /** Fires the signal of an effect an application is running. */
  'effect/cancel': { instance: string; key: string };
};

/** One effect for an application to run. */
export type EffectRun = {
  instance: string;
  key: string;
  kind: string;
  args: Json;
  attempt: number;
};

/** How an application's handler ended: a result, or what it threw. */
export type EffectResult = { ok: Json } | { error: Json };

/** Requests the runner sends an application that provides kinds. */
export type ProviderMethods = {
  'effect/run': { params: EffectRun; result: EffectResult };
};

/** Notifications an application that provides kinds sends the runner. */
export type ProviderNotifications = {
  'effect/emit': { instance: string; key: string; delta: Json };
};

/** What a JSON-RPC error's `data.code` can say. */
export type ErrorCode =
  | 'closed'
  | 'no_agent'
  | 'no_instance'
  | 'instance_exists'
  | 'bundle_conflict'
  | 'invalid_bundle'
  | 'missing_kinds'
  | 'request_conflict'
  | 'kind_taken'
  | 'agent_in_use'
  | 'not_initialized'
  | 'protocol_version'
  | 'invalid_params'
  | 'internal';
