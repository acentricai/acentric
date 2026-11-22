// An agent's secrets: values its code reads by name, such as the key of an API it calls.
//
// A value is sealed before it is stored, with a key the engine is started with and the store
// never has. So a copy of the database gives no secret away. Nothing reads a value back but
// the agent's own code, through the executor.
//
// Keys have IDs, and a sealed value says which key sealed it. So a key is changed without
// losing anything: the new one is given as the current, the old one stays to open what it
// sealed, and `reseal` seals everything again with the new one, after which the old may go.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { AgentId } from '@acentric/protocol';

import { EngineError } from './errors.ts';
import type { Store } from './store.ts';

/** The keys an engine seals with. */
export type SecretKeys = {
  /** The ID of the key new values are sealed with. */
  readonly current: string;
  /** Every key there is, by ID: 32 bytes each. */
  readonly keys: { readonly [id: string]: Uint8Array };
};

/** The engine was started without a key, so it keeps no secrets. */
export class SecretsUnavailable extends EngineError {
  override readonly name = 'SecretsUnavailable';
  readonly code = 'unavailable';
  constructor() {
    super('The engine was started without a key for secrets, so it keeps none');
  }
}

export class InvalidSecretName extends EngineError {
  override readonly name = 'InvalidSecretName';
  readonly code = 'invalid_request';
  constructor(name: string) {
    super(
      `${JSON.stringify(name)} is not a secret's name: letters, digits and _, not starting with a digit`,
    );
  }
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const FORMAT = 'v1';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** A key from how it was given: 32 bytes, as 64 hex characters or as base64. */
export function secretKeyOf(given: string): Uint8Array {
  const key = /^[0-9a-fA-F]{64}$/.test(given)
    ? Buffer.from(given, 'hex')
    : Buffer.from(given, 'base64');
  if (key.length !== 32) {
    throw new Error('A key for secrets is 32 bytes, as 64 hex characters or as base64');
  }
  return key;
}

export class Secrets {
  readonly #store: Store;
  readonly #keys: SecretKeys | undefined;
  readonly #clock: () => number;

  constructor(options: {
    readonly store: Store;
    /** Without them, every secret is refused: none is kept unsealed. */
    readonly keys?: SecretKeys;
    readonly clock?: () => number;
  }) {
    const { keys } = options;
    if (keys !== undefined) {
      for (const [id, key] of Object.entries(keys.keys)) {
        if (!KEY_ID.test(id)) throw new Error(`${JSON.stringify(id)} is not the ID of a key`);
        if (key.length !== 32) throw new Error(`The key ${id} is not 32 bytes`);
      }
      if (keys.keys[keys.current] === undefined) {
        throw new Error(`The current key, ${keys.current}, is not among the keys`);
      }
    }
    this.#store = options.store;
    this.#keys = keys;
    this.#clock = options.clock ?? Date.now;
  }

  /** Sets the secret `name` of `agent`, in place of the value it had. */
  async set(agent: AgentId, name: string, value: string): Promise<void> {
    if (!NAME.test(name)) throw new InvalidSecretName(name);
    const sealed = this.seal(`${agent}\0${name}`, value);
    await this.#store.setSecret({ agent, name, sealed, updatedAt: this.#clock() });
  }

  /** The names of the agent's secrets, in order. Never their values. */
  names(agent: AgentId): Promise<string[]> {
    return this.#store.secretNames(agent);
  }

  /** Removes the secret. False when there was none of that name. */
  delete(agent: AgentId, name: string): Promise<boolean> {
    return this.#store.deleteSecret(agent, name);
  }

  /** The value of the secret, for the agent's code. Undefined when none is set by that name. */
  async get(agent: AgentId, name: string): Promise<string | undefined> {
    const secret = await this.#store.getSecret(agent, name);
    if (secret === undefined) return undefined;
    return this.open(`${agent}\0${name}`, secret.sealed, `The secret ${name} of ${agent}`);
  }

  /**
   * Seals every secret that another key sealed with the current one, and gives how many it
   * sealed. After it, the other keys open nothing that is stored.
   */
  async reseal(): Promise<number> {
    const { current } = this.#required();
    let sealed = 0;
    for (const secret of await this.#store.allSecrets()) {
      if (secret.sealed.split('.')[1] === current) continue;
      const bound = `${secret.agent}\0${secret.name}`;
      const value = this.open(bound, secret.sealed, `The secret ${secret.name}`);
      await this.#store.setSecret({ ...secret, sealed: this.seal(bound, value) });
      sealed += 1;
    }
    return sealed;
  }

  /**
   * Seals a value with the current key. `bound` says what the value is of: a value sealed for
   * one thing does not open as another's, though both are in the same store.
   */
  seal(bound: string, value: string): string {
    const { current, keys } = this.#required();
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', keys[current] as Uint8Array, nonce);
    cipher.setAAD(Buffer.from(bound));
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const bytes = Buffer.concat([nonce, body, cipher.getAuthTag()]);
    return `${FORMAT}.${current}.${bytes.toString('base64')}`;
  }

  /** Opens what `seal` sealed for the same thing. `what` names it, for when it does not open. */
  open(bound: string, sealed: string, what: string): string {
    const { keys } = this.#required();
    const [format, id, data, ...rest] = sealed.split('.');
    if (format !== FORMAT || id === undefined || data === undefined || rest.length > 0) {
      throw new Error(`${what} is not sealed in a way this engine reads`);
    }
    const key = keys[id];
    if (key === undefined) {
      throw new Error(`${what} was sealed with the key ${id}, which this engine was not given`);
    }
    const bytes = Buffer.from(data, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, NONCE_BYTES));
    decipher.setAAD(Buffer.from(bound));
    decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
    try {
      return Buffer.concat([
        decipher.update(bytes.subarray(NONCE_BYTES, bytes.length - TAG_BYTES)),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new Error(`${what} does not open with the key ${id}: it was sealed with another`);
    }
  }

  #required(): SecretKeys {
    if (this.#keys === undefined) throw new SecretsUnavailable();
    return this.#keys;
  }
}
