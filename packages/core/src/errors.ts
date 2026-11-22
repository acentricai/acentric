// What the engine refuses, each with the code the API answers it with.

import type { ActorId, AgentId, CallIssue, ErrorCode } from '@acentric/protocol';

/** Something the engine was asked that it does not do. `code` is what the API says of it. */
export abstract class EngineError extends Error {
  abstract readonly code: ErrorCode;
}

export class ActorNotFound extends EngineError {
  override readonly name = 'ActorNotFound';
  readonly code = 'not_found';
  constructor(actor: ActorId) {
    super(`There is no actor ${actor}`);
  }
}

export class AgentNotFound extends EngineError {
  override readonly name = 'AgentNotFound';
  readonly code = 'not_found';
  constructor(agent: AgentId | string, version?: number) {
    super(
      version === undefined
        ? `There is no agent ${agent}`
        : `The agent ${agent} has no version ${String(version)}`,
    );
  }
}

/** The code that was deployed is not an agent's, or not one this agent can become. */
export class InvalidAgent extends EngineError {
  override readonly name = 'InvalidAgent';
  readonly code = 'invalid_agent';
}

/** The code was built for a bundle protocol this engine does not run. */
export class UnsupportedProtocol extends EngineError {
  override readonly name = 'UnsupportedProtocol';
  readonly code = 'unsupported_protocol';
}

/** The code uses what this engine does not have: a provider, or a feature. */
export class UnsupportedFeature extends EngineError {
  override readonly name = 'UnsupportedFeature';
  readonly code = 'unsupported_feature';
}

/** An actor's configuration failed its agent's schema. */
export class InvalidConfiguration extends EngineError {
  override readonly name = 'InvalidConfiguration';
  readonly code = 'invalid_configuration';
  /** What the schema found wrong with it. Absent when the agent's code threw. */
  readonly issues: readonly CallIssue[] | undefined;
  constructor(message: string, issues?: readonly CallIssue[]) {
    super(message);
    this.issues = issues;
  }
}

/** The actor is in a turn, and this is done only between turns. */
export class ActorBusy extends EngineError {
  override readonly name = 'ActorBusy';
  readonly code = 'actor_busy';
  constructor(actor: ActorId) {
    super(`The actor ${actor} is in a turn: this is done between turns`);
  }
}

/** The actor is archived, and takes nothing until it is unarchived. */
export class ActorArchived extends EngineError {
  override readonly name = 'ActorArchived';
  readonly code = 'actor_archived';
  constructor(actor: ActorId) {
    super(`The actor ${actor} is archived`);
  }
}

/** The agent has no input of that type. */
export class UnknownInput extends EngineError {
  override readonly name = 'UnknownInput';
  readonly code = 'unknown_input';
  constructor(type: string) {
    super(`The agent has no input of type ${type}`);
  }
}

/** The agent's own code refused what was sent. */
export class InvalidInput extends EngineError {
  override readonly name = 'InvalidInput';
  readonly code = 'invalid_input';
  /** What the input's schema found wrong with it. Absent when the agent's code threw. */
  readonly issues: readonly CallIssue[] | undefined;
  constructor(message: string, issues?: readonly CallIssue[]) {
    super(message);
    this.issues = issues;
  }
}

/** What was asked cannot be done as the actor stands. */
export class Conflict extends EngineError {
  override readonly name = 'Conflict';
  readonly code = 'conflict';
}

/**
 * The agent's code could not be run just now: what runs it died with the call in it. The same
 * request may work when it is made again. Whether the code did anything is not known.
 */
export class CodeUnavailable extends EngineError {
  override readonly name = 'CodeUnavailable';
  readonly code = 'unavailable';
  constructor(reason: string) {
    super(`The agent's code could not be run just now: ${reason}`);
  }
}

/** The engine is shutting down, and takes nothing new. */
export class Unavailable extends EngineError {
  override readonly name = 'Unavailable';
  readonly code = 'unavailable';
  constructor() {
    super('The engine is shutting down');
  }
}
