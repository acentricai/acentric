// What a provider of sandboxes is to the engine: the interface one implements. The engine
// knows nothing of any provider but this. Where a sandbox is made, and how it is asked for, is
// the provider's own.
//
// A provider makes a sandbox from something that has the daemon in it, puts a file there with
// what the daemon enrols with, and starts it. From then on the daemon is all the engine talks
// to: a provider is asked only to make, start, stop and delete, and how a sandbox stands.

import type { SandboxState } from '@acentric/protocol';

import { EngineError } from './errors.ts';

/** The labels a sandbox carries at its provider: the machine it is, and the account it was made in. */
export const LABEL_MACHINE = 'acentric.machine';
export const LABEL_PROVIDER = 'acentric.provider';

/** A sandbox, as its provider has it. */
export type ProviderSandbox = {
  /** The provider's own ID for it. */
  readonly id: string;
  readonly state: SandboxState;
  /** Absent when the provider does not say. */
  readonly labels?: { readonly [name: string]: string };
};

/** What a provider is asked to make. */
export type NewSandbox = {
  /** The machine it becomes, and what that machine is called. */
  readonly machine: string;
  readonly name: string;
  readonly vcpu: number;
  readonly memoryGB: number;
  /** How many seconds it may be idle before it is stopped. */
  readonly idleSeconds: number;
  readonly labels: { readonly [name: string]: string };
  /**
   * What its daemon enrols with, as the text of a file. The provider puts it where the
   * sandbox's start-up looks for it, before the sandbox starts.
   */
  readonly provision: string;
  /** One of its own for each try: a provider that is asked twice with one makes one sandbox. */
  readonly key: string;
  /** The provider's name for the template it is made from. Without it, the server's own. */
  readonly template?: string;
};

/** The label a template's builder carries at its provider: the template it builds. */
export const LABEL_TEMPLATE = 'acentric.template';

/** What a provider is asked to build a template with. */
export type TemplateBuild = {
  /** The provider's name for what is saved. One saved under it before is replaced. */
  readonly name: string;
  /** What people call it. */
  readonly label: string;
  /** A shell script, run first, as the sandbox's user. */
  readonly script: string;
  /** The machine program for a processor, such as `x64` or `arm64`. Undefined for one there is none for. */
  readonly program: (arch: string) => Uint8Array | undefined;
  /** What the builder carries: the template, and the account. */
  readonly labels: { readonly [name: string]: string };
  /** One of its own for each build, as for a sandbox. */
  readonly key: string;
  /** The longest the script may run, in seconds. */
  readonly scriptSeconds: number;
  /** All the build has printed so far, each time it has printed more. */
  readonly output: (text: string) => void;
  /** Stops the build: the builder is deleted, and nothing is saved. */
  readonly signal: AbortSignal;
};

/** A build that did not end in a template. What it printed is in its output. */
export class TemplateFailed extends EngineError {
  override readonly name = 'TemplateFailed';
  readonly code = 'sandbox_provider_failed';
}

/** One account at a provider, with its credential: what the engine asks things of. */
export interface SandboxAccount {
  /** Who the provider says the account belongs to. Rejects for a credential it refuses. */
  whoami(): Promise<string | null>;
  create(sandbox: NewSandbox): Promise<ProviderSandbox>;
  /** How a sandbox stands. `gone` when the provider no longer has it. */
  state(id: string): Promise<SandboxState>;
  /**
   * Has it stop by itself `idleSeconds` from now. Only a provider that stops sandboxes itself
   * has this.
   */
  keepFor?(id: string, idleSeconds: number): Promise<void>;
  /**
   * Starts a stopped sandbox again. A start that is already under way counts as done, and
   * answers false: whoever began it said how long it may be idle. Rejects with a
   * `ProviderFailed` whose `reason` is `busy` while it is still stopping.
   */
  start(id: string, idleSeconds: number): Promise<boolean>;
  /** Stops it, and keeps its disk. One that is stopped already is stopped. */
  stop?(id: string): Promise<void>;
  /** Deletes the sandbox and its disk for good. One the provider no longer has is deleted already. */
  delete(id: string): Promise<void>;
  /** Every sandbox that carries a label, whatever its state, by the provider's ID for it. */
  list(label: string, value: string): Promise<Map<string, ProviderSandbox>>;
  /**
   * Builds a template: in a sandbox of its own, the script, then the machine program and its
   * start-up, and saves that sandbox's disk under the build's name. The builder is deleted
   * however it ends. Rejects with `TemplateFailed` for a build that failed. Only a provider
   * that builds templates has this.
   */
  buildTemplate?(build: TemplateBuild): Promise<void>;
  /** Deletes a template it saved. One it no longer has is deleted already. */
  deleteTemplate?(name: string): Promise<void>;
}

/** A provider of sandboxes, as an engine is set up with it. */
export interface SandboxProvider {
  /** What accounts and sandboxes of it say they are, such as `docker`. */
  readonly kind: string;
  /** What people call it, such as `Docker`. */
  readonly label: string;
  /** Whether an account of it is added with an API key. */
  readonly credential: 'api_key' | 'none';
  /**
   * Who stops a sandbox that nothing was run on for its idle time. `provider`: the provider
   * does, by a timer the engine sets again while it is used, with `keepFor`. `engine`: the
   * engine does, with `stop`.
   */
  readonly idle: 'provider' | 'engine';
  /** What is wrong with a size it does not make. Undefined for one it does. */
  sizeProblem(vcpu: number, memoryGB: number): string | undefined;
  /**
   * Why no sandbox can be made from the server's own template: what the server was not set up
   * with. Undefined when one can.
   */
  unavailable?(): string | undefined;
  /** Where a sandbox of it reaches a server that people reach at `url`, when that is elsewhere. */
  serverFor?(url: string): string;
  /** An account of it. `credential` is its API key, or null for a provider that has none. */
  account(credential: string | null, options: { readonly requestMs: number }): SandboxAccount;
}

/** A provider failed, or refused. Its own reason is passed on, cut short. */
export class ProviderFailed extends EngineError {
  override readonly name = 'ProviderFailed';
  readonly code: 'sandbox_provider_failed' | 'rate_limited' | 'unavailable';
  /** The HTTP status it answered with. 0 when it did not answer. */
  readonly status: number;
  /**
   * What the engine does differently for: a credential the provider refuses, a sandbox it no
   * longer has, and one that is busy stopping and can be asked again in a moment.
   */
  readonly reason: 'credential' | 'gone' | 'busy' | 'other';

  constructor(
    message: string,
    given: {
      readonly status?: number;
      readonly code?: ProviderFailed['code'];
      readonly reason?: ProviderFailed['reason'];
    } = {},
  ) {
    super(message);
    this.status = given.status ?? 0;
    this.code = given.code ?? 'sandbox_provider_failed';
    this.reason = given.reason ?? 'other';
  }
}

/**
 * What a provider's failure is to the engine, from the status it answered with: refused,
 * gone, too many, or not there now.
 */
export function providerFailure(label: string, status: number, said?: string): ProviderFailed {
  const text = `${label} answered ${String(status)}${
    said === undefined || said === '' ? '' : `: ${[...said].slice(0, 300).join('')}`
  }`;
  if (status === 401 || status === 403) {
    return new ProviderFailed(
      `${label} refused the account's credential: add the account again with a new one`,
      { status, reason: 'credential' },
    );
  }
  if (status === 404) return new ProviderFailed(text, { status, reason: 'gone' });
  if (status === 429) return new ProviderFailed(text, { status, code: 'rate_limited' });
  if (status === 503) return new ProviderFailed(text, { status, code: 'unavailable' });
  return new ProviderFailed(text, { status });
}
