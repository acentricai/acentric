// Boat (boat.dev), as a provider of sandboxes: a sandbox is one of Boat's, in an account
// that is added by its API key. It is made from a saved snapshot that has the daemon in it,
// the template (see `deploy/sandbox/boat-template.sh`). Boat is given a file to put in the
// new sandbox, with what its daemon enrols with.
//
// Boat stops a sandbox when its own timer runs out, whatever runs in it, and keeps its disk.
// The engine uses that timer as the sandbox's idle time, and sets it again while the sandbox
// is used: so a sandbox stops by itself when nothing was run on it for that long, even when
// the engine is not there.

import { ProviderFailed } from '@acentric/core';
import type {
  NewSandbox,
  ProviderSandbox,
  SandboxAccount,
  SandboxProvider,
  TemplateBuild,
} from '@acentric/core';
import type { SandboxState } from '@acentric/protocol';

import { buildAtBoat } from './boat-template.ts';

/** Boat's sizes: the only pairs of vCPU and memory it makes. */
export const BOAT_SIZES = [
  { type: 'small', vcpu: 2, memoryGB: 4 },
  { type: 'default', vcpu: 4, memoryGB: 8 },
  { type: 'large', vcpu: 8, memoryGB: 16 },
  { type: 'xlarge', vcpu: 16, memoryGB: 32 },
] as const;

/** Where the template's start-up looks for what its daemon enrols with. */
export const BOAT_PROVISION_PATH = '/home/user/.acentric-provision.json';

export type BoatOptions = {
  /** The saved snapshot sandboxes are made from, which has the daemon in it. Without it none is made. */
  readonly template?: string;
  /** Boat's API, in place of https://boat.dev/api/v1. */
  readonly url?: string;
  readonly fetch?: typeof fetch;
  /** How a template is built: between two looks at it, and how long it may take to start and be saved. For tests. */
  readonly templateTimes?: {
    readonly pollMs?: number;
    readonly startMs?: number;
    readonly saveMs?: number;
  };
};

type BoatSandbox = {
  readonly id: string;
  readonly state?: string;
  readonly labels?: { readonly [name: string]: string };
};

/** Boat's states, as its API reports them, in the engine's words. */
export function boatState(state: string | undefined): SandboxState {
  switch (state) {
    case 'init':
    case 'provisioning':
    case 'provisioned':
    case 'cloning':
      return 'starting';
    case 'ready':
    case 'idle':
    case 'running':
      return 'running';
    case 'archiving':
      return 'stopping';
    case 'archived':
      return 'stopped';
    case 'error':
      return 'error';
    case 'cancelled':
      return 'gone';
    default:
      return 'unknown';
  }
}

type BoatError = {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
};

/** What Boat's refusal is to the engine. `boatCode` is Boat's own code for it, when it gave one. */
function boatFailure(
  status: number,
  data: BoatError | null,
): ProviderFailed & { boatCode: string | null } {
  const code = data?.error?.code ?? data?.code;
  const boatCode = typeof code === 'string' ? code : null;
  const message = data?.error?.message ?? data?.message;
  const text = `Boat answered ${String(status)}${boatCode === null ? '' : ` ${boatCode}`}${
    typeof message === 'string' ? `: ${[...message].slice(0, 300).join('')}` : ''
  }`;
  const failed = (said: string, given: ConstructorParameters<typeof ProviderFailed>[1]) =>
    Object.assign(new ProviderFailed(said, { status, ...given }), { boatCode });
  if (status === 401) {
    return failed("Boat refused the account's API key: add the account again with a new key", {
      reason: 'credential',
    });
  }
  if (status === 404) return failed(text, { reason: 'gone' });
  if (status === 429) return failed(text, { code: 'rate_limited' });
  if (status === 503) return failed(text, { code: 'unavailable' });
  // One that is still saving its disk holds its machine for a moment: it is asked again.
  if (boatCode === 'sandbox_stopping') return failed(text, { reason: 'busy' });
  return failed(text, {});
}

const boatCodeOf = (error: unknown): string | null =>
  error instanceof ProviderFailed
    ? ((error as { boatCode?: string | null }).boatCode ?? null)
    : null;

/** Boat's API, with one account's key. */
function accountOf(options: BoatOptions, apiKey: string, requestMs: number): SandboxAccount {
  const base = (options.url ?? 'https://boat.dev/api/v1').replace(/\/$/, '');
  const send = options.fetch ?? fetch;

  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: { readonly [name: string]: string } = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await send(base + path, {
        method,
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'manual',
        signal: AbortSignal.timeout(requestMs),
      });
    } catch {
      throw new ProviderFailed('Boat could not be reached');
    }
    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      // The status is enough.
    }
    if (!response.ok) throw boatFailure(response.status, data as BoatError | null);
    return data as T;
  }

  const view = (sandbox: BoatSandbox): ProviderSandbox => ({
    id: sandbox.id,
    state: boatState(sandbox.state),
    ...(sandbox.labels === undefined ? {} : { labels: sandbox.labels }),
  });
  const one = (id: string): string => `/sandboxes/${encodeURIComponent(id)}`;

  return {
    async whoami(): Promise<string | null> {
      const data = await call<{ user?: { email?: unknown; login?: unknown } }>('GET', '/me');
      const who = data.user?.email ?? data.user?.login;
      return typeof who === 'string' ? who.slice(0, 254) : null;
    },

    async create(sandbox: NewSandbox): Promise<ProviderSandbox> {
      const size = BOAT_SIZES.find(
        (each) => each.vcpu === sandbox.vcpu && each.memoryGB === sandbox.memoryGB,
      );
      const data = await call<{ sandbox?: BoatSandbox }>(
        'POST',
        '/sandboxes',
        {
          from: sandbox.template ?? options.template,
          type: size?.type,
          name: `acentric ${sandbox.machine}`,
          ttlSeconds: sandbox.idleSeconds,
          labels: sandbox.labels,
          files: [{ path: BOAT_PROVISION_PATH, content: sandbox.provision }],
        },
        { 'idempotency-key': sandbox.key },
      );
      if (data.sandbox === undefined || typeof data.sandbox.id !== 'string') {
        throw new ProviderFailed('Boat answered without a sandbox');
      }
      return view(data.sandbox);
    },

    async state(id: string): Promise<SandboxState> {
      try {
        const data = await call<{ sandbox?: BoatSandbox }>('GET', one(id));
        // One Boat says nothing of is one it no longer has.
        return boatState(data.sandbox?.state ?? 'cancelled');
      } catch (error) {
        if (error instanceof ProviderFailed && error.reason === 'gone') return 'gone';
        throw error;
      }
    },

    async keepFor(id: string, idleSeconds: number): Promise<void> {
      await call('PATCH', one(id), { ttlSeconds: idleSeconds });
    },

    async start(id: string, idleSeconds: number): Promise<boolean> {
      try {
        await call('POST', `${one(id)}/resume`, { ttlSeconds: idleSeconds });
        return true;
      } catch (error) {
        // Under way already: its timer was set by whoever began it, perhaps for another length.
        if (boatCodeOf(error) === 'sandbox_resuming') return false;
        throw error;
      }
    },

    async delete(id: string): Promise<void> {
      try {
        await call('DELETE', one(id), undefined, { 'x-ascii-confirm-delete': id });
      } catch (error) {
        if (error instanceof ProviderFailed && error.reason === 'gone') return;
        throw error;
      }
    },

    async buildTemplate(build: TemplateBuild): Promise<void> {
      await buildAtBoat(
        {
          call,
          async put(url, bytes) {
            let response: Response;
            try {
              response = await send(url, {
                method: 'PUT',
                body: bytes,
                signal: AbortSignal.timeout(Math.max(requestMs, 300_000)),
              });
            } catch {
              throw new ProviderFailed('The machine program could not be put in the sandbox');
            }
            if (!response.ok) {
              throw new ProviderFailed(
                `The machine program could not be put in the sandbox: Boat answered ${String(response.status)}`,
              );
            }
          },
          pollMs: options.templateTimes?.pollMs ?? 3000,
          startMs: options.templateTimes?.startMs ?? 300_000,
          saveMs: options.templateTimes?.saveMs ?? 1_800_000,
        },
        build,
      );
    },

    async deleteTemplate(name: string): Promise<void> {
      try {
        await call('DELETE', `/saved-snapshots/${encodeURIComponent(name)}`);
      } catch (error) {
        if (error instanceof ProviderFailed && error.reason === 'gone') return;
        throw error;
      }
    },

    async list(label: string, value: string): Promise<Map<string, ProviderSandbox>> {
      const found = new Map<string, ProviderSandbox>();
      let cursor: string | null = null;
      for (let page = 0; page < 50; page += 1) {
        const query = new URLSearchParams({ label: `${label}=${value}`, limit: '200' });
        if (cursor !== null) query.set('cursor', cursor);
        const data: {
          sandboxes?: BoatSandbox[];
          pageInfo?: { nextCursor?: string | null; hasMore?: boolean };
        } = await call('GET', `/sandboxes?${query.toString()}`);
        for (const sandbox of data.sandboxes ?? []) found.set(sandbox.id, view(sandbox));
        const next = data.pageInfo?.nextCursor;
        if (data.pageInfo?.hasMore !== true || next === undefined || next === null || next === '') {
          break;
        }
        cursor = next;
      }
      return found;
    },
  };
}

/** Boat, as a provider of sandboxes. */
export function boat(options: BoatOptions = {}): SandboxProvider {
  return {
    kind: 'boat',
    label: 'Boat',
    credential: 'api_key',
    idle: 'provider',
    sizeProblem(vcpu: number, memoryGB: number): string | undefined {
      if (BOAT_SIZES.some((each) => each.vcpu === vcpu && each.memoryGB === memoryGB)) {
        return undefined;
      }
      const sizes = BOAT_SIZES.map(
        (each) => `${String(each.vcpu)} vCPU / ${String(each.memoryGB)} GB`,
      ).join(', ');
      return `Boat has no ${String(vcpu)} vCPU / ${String(memoryGB)} GB size. Its sizes: ${sizes}`;
    },
    unavailable(): string | undefined {
      const template = options.template?.trim();
      return template === undefined || template === ''
        ? 'Sandboxes at Boat are not set up on this server: it was started without ACENTRIC_BOAT_TEMPLATE'
        : undefined;
    },
    account: (credential, { requestMs }) => accountOf(options, credential ?? '', requestMs),
  };
}
