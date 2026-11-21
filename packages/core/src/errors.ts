// What the engine refuses, each with the code the API answers it with.

import type { ActorId, ErrorCode } from '@acentric/protocol';

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
}

/** What was asked cannot be done as the actor stands. */
export class Conflict extends EngineError {
  override readonly name = 'Conflict';
  readonly code = 'conflict';
}

/** The engine is shutting down, and takes nothing new. */
export class Unavailable extends EngineError {
  override readonly name = 'Unavailable';
  readonly code = 'unavailable';
  constructor() {
    super('The engine is shutting down');
  }
}
