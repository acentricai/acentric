// The engine's API keys: those no wider than the person signed in, made and revoked here. A key
// reaches the whole engine, one agent or one actor, with the permissions it was made with.

import { IconAlertTriangle, IconPlus } from '@tabler/icons-react';
import { useMutation, useQueries, useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';

import type { CreateKeyResponse, Key, Permission, Scope } from '@acentric/protocol';

import { api } from '../api.ts';
import { fullTime, NOTHING } from '../format.ts';
import { useMe, type Me } from '../me.ts';
import {
  Ago,
  Button,
  CopyButton,
  Dialog,
  Field,
  FormError,
  PageHeader,
  Segmented,
  errorText,
} from '../ui.tsx';
import { engine, queryClient } from './api.ts';
import { grantable, PERMISSION_TEXT, reachText, SCOPES, type ScopeType } from './scopes.ts';

import './keys.css';

export const SHOWN_ONCE = 'Key';

const LIST_REFRESH = 10_000;

export const keyQueries = {
  keys: ['keys'] as const,
  agents: ['agents', 'list'] as const,
  actorsOf: (agent: string) => ['actors', 'of', agent] as const,
  actor: (actor: string) => ['actors', actor] as const,
};

/** How long a new key works. */
const EXPIRIES = [
  { value: 'never', text: 'Never', ms: null },
  { value: 'hour', text: '1 hour', ms: 3_600_000 },
  { value: 'day', text: '1 day', ms: 86_400_000 },
  { value: 'month', text: '30 days', ms: 30 * 86_400_000 },
  { value: 'quarter', text: '90 days', ms: 90 * 86_400_000 },
] as const;

export function useKeys() {
  return useQuery({
    queryKey: keyQueries.keys,
    queryFn: ({ signal }) => engine.keys(signal),
    refetchInterval: LIST_REFRESH,
  });
}

function useAgents(enabled = true) {
  return useQuery({
    // The Agents and Machines pages keep the same list: the server's page of it, as it is.
    queryKey: keyQueries.agents,
    queryFn: ({ signal }) => engine.agents(signal),
    select: (page) => page.items,
    enabled,
  });
}

/** What the agents and actors keys reach are called, by their IDs. */
function useReachNames(rows: readonly Key[] | undefined): Map<string, string> {
  const agents = useAgents();
  const actors = [
    ...new Set(
      (rows ?? []).flatMap((key) => (key.scope.type === 'actor' ? [key.scope.actor] : [])),
    ),
  ];
  const read = useQueries({
    queries: actors.map((actor) => ({
      queryKey: keyQueries.actor(actor),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.call('actors.get', { params: { actor: actor as never }, signal }),
      staleTime: 60_000,
    })),
  });
  const names = new Map<string, string>();
  for (const agent of agents.data ?? []) names.set(agent.id, agent.name);
  actors.forEach((actor, index) => {
    const name = read[index]?.data?.name;
    if (name !== undefined && name !== null) names.set(actor, name);
  });
  return names;
}

/** The start of a key, which is all of it that can be shown again: its ID. */
export const maskOf = (key: Key) => `ak_${key.id.slice('key_'.length)}_…`;

/** A key's permissions, as chips. */
export function Permissions({ permissions }: { permissions: readonly Permission[] }) {
  return (
    <span className="chips">
      {permissions.map((permission) => (
        <span key={permission} className="chip chip--mono">
          {permission}
        </span>
      ))}
    </span>
  );
}

export function KeysPage() {
  const me = useMe();
  const keys = useKeys();
  const [creating, setCreating] = useState(false);
  const [made, setMade] = useState<CreateKeyResponse | null>(null);
  const [revoking, setRevoking] = useState<Key | null>(null);
  // Only IDs belong to row presentation; the secret stays in `made` exactly until its dialog is
  // dismissed.
  const [fresh, setFresh] = useState<string | null>(null);
  const [revoked, setRevoked] = useState<ReadonlySet<string>>(new Set());
  const revoke = useMutation({
    mutationFn: (key: Key) => engine.revokeKey(key.id),
    onSuccess: (_, key) => {
      setRevoked((was) => new Set([...was, key.id]));
      setRevoking(null);
      void queryClient.invalidateQueries({ queryKey: keyQueries.keys });
    },
  });

  const rows = keys.data?.items;
  const names = useReachNames(rows);
  return (
    <div className="list-page keys-page team">
      <PageHeader title="API keys" spaced>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <IconPlus size={15} stroke={1.75} aria-hidden="true" />
          New key
        </Button>
      </PageHeader>
      <div className="rise">
        {keys.isError && (
          <div className="state-error" role="alert">
            <IconAlertTriangle size={18} stroke={1.75} aria-hidden="true" />
            <div>
              <p className="state-error__title">API keys</p>
              <FormError error={keys.error} />
            </div>
            <Button size="sm" onClick={() => void keys.refetch()}>
              Retry
            </Button>
          </div>
        )}
        {keys.isPending ? (
          <div className="skeleton keys-skeleton" role="status" aria-label="Loading API keys">
            {Array.from({ length: 4 }, (_, i) => (
              <span key={i} className="skeleton__line" />
            ))}
          </div>
        ) : rows !== undefined ? (
          <div className="ac-table-wrap">
            <table className="ac-table keys-table" aria-label="Keys">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Key</th>
                  <th scope="col">Reaches</th>
                  <th scope="col">Permissions</th>
                  <th scope="col">Expires</th>
                  <th scope="col">Created</th>
                  <th scope="col">Last used</th>
                  <th scope="col" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map((key) => (
                  <tr
                    key={key.id}
                    className={`${revoked.has(key.id) ? 'row--revoked' : ''} ${fresh === key.id && !revoked.has(key.id) ? 'row-in' : ''}`}
                  >
                    <td>
                      <span className="ac-table__name">{key.label}</span>
                    </td>
                    <td>
                      <code className="key-mask">{maskOf(key)}</code>
                    </td>
                    <td>
                      <span className="mono">{reachText(key.scope, names)}</span>
                    </td>
                    <td>
                      <Permissions permissions={key.permissions} />
                    </td>
                    <td>
                      <span
                        className="ac-table__muted"
                        title={key.expiresAt === null ? undefined : fullTime(key.expiresAt)}
                      >
                        {key.expiresAt === null ? 'Never' : fullTime(key.expiresAt)}
                      </span>
                    </td>
                    <td>
                      <span className="ac-table__muted">
                        <Ago at={key.createdAt} />
                      </span>
                    </td>
                    <td>
                      <span className="ac-table__muted">
                        {key.lastUsedAt === null ? NOTHING : <Ago at={key.lastUsedAt} />}
                      </span>
                    </td>
                    <td className="ac-table__num">
                      {!revoked.has(key.id) && (
                        <Button
                          variant="quiet"
                          size="sm"
                          className="row-action"
                          onClick={() => setRevoking(key)}
                        >
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && <p className="table-empty">No keys</p>}
          </div>
        ) : null}
      </div>
      {creating && (
        <NewKeyDialog
          me={me.data}
          onClose={() => setCreating(false)}
          onMade={(result) => {
            setCreating(false);
            setMade(result);
            setFresh(result.key.id);
          }}
        />
      )}
      {made !== null && <KeyShown made={made} onDone={() => setMade(null)} />}
      {revoking !== null && (
        <Dialog
          title={`Revoke ${revoking.label}?`}
          onClose={() => {
            revoke.reset();
            setRevoking(null);
          }}
          footer={
            <>
              <Button
                onClick={() => {
                  revoke.reset();
                  setRevoking(null);
                }}
                data-autofocus
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                busy={revoke.isPending}
                onClick={() => revoke.mutate(revoking)}
              >
                Revoke
              </Button>
            </>
          }
        >
          <p className="note">
            Anything that calls the engine with it, or with a key made with it, is refused from now
            on.
          </p>
          <FormError error={revoke.error} />
        </Dialog>
      )}
    </div>
  );
}

const SCOPE_NAMES: { readonly [T in ScopeType]: string } = {
  engine: 'Whole engine',
  agent: 'One agent',
  actor: 'One actor',
};

export function NewKeyDialog({
  me,
  onClose,
  onMade,
}: {
  me: Me | undefined;
  onClose: () => void;
  onMade: (made: CreateKeyResponse) => void;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<ScopeType>('engine');
  // The agent a key of one agent reaches, or whose actor a key of one actor reaches.
  const [agent, setAgent] = useState('');
  const [actor, setActor] = useState('');
  const [ticked, setTicked] = useState<ReadonlySet<Permission>>(new Set());
  const [expiry, setExpiry] = useState<(typeof EXPIRIES)[number]['value']>('never');
  const formId = useId();
  const agents = useAgents(type !== 'engine');
  const actors = useQuery({
    queryKey: keyQueries.actorsOf(agent),
    queryFn: async ({ signal }) => (await engine.actorsOf(agent, signal)).items,
    enabled: type === 'actor' && agent !== '',
  });
  const offered = grantable(me, type);
  const permissions = offered.filter((permission) => ticked.has(permission));
  const scope: Scope =
    type === 'engine'
      ? { type: 'engine' }
      : type === 'agent'
        ? { type: 'agent', agent: agent as never }
        : { type: 'actor', actor: actor as never };
  const ready =
    name.trim() !== '' &&
    permissions.length > 0 &&
    (type === 'engine' || (type === 'agent' ? agent !== '' : actor !== ''));
  const tick = (permission: Permission, on: boolean) =>
    setTicked((was) => {
      const next = new Set(was);
      if (on) next.add(permission);
      else next.delete(permission);
      return next;
    });
  const create = useMutation({
    mutationFn: () => {
      const ms = EXPIRIES.find((each) => each.value === expiry)?.ms ?? null;
      return engine.createKey({
        label: name.trim(),
        scope,
        permissions,
        service: false,
        ...(ms === null ? {} : { expiresAt: Date.now() + ms }),
      });
    },
    onSuccess: (made) => {
      void queryClient.invalidateQueries({ queryKey: keyQueries.keys });
      onMade(made);
    },
  });
  return (
    <Dialog
      title="New key"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            busy={create.isPending}
            disabled={!ready}
          >
            New key
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !create.isPending) create.mutate();
        }}
      >
        <Field label="Name" error={create.isError ? errorText(create.error) : undefined}>
          {(id) => (
            <input
              id={id}
              className="ac-input"
              required
              autoComplete="off"
              maxLength={128}
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-invalid={create.isError || undefined}
            />
          )}
        </Field>
        <div className="ac-field">
          <span className="ac-field__label">Reaches</span>
          <Segmented
            label="Reaches"
            value={type}
            options={SCOPES.map((each) => [each, SCOPE_NAMES[each]] as const)}
            onChange={(value) => {
              setType(value);
              setActor('');
            }}
          />
        </div>
        {type !== 'engine' && (
          <Field label="Agent">
            {(id) => (
              <span className="select">
                <select
                  id={id}
                  className="ac-input"
                  required
                  value={agent}
                  onChange={(event) => {
                    setAgent(event.target.value);
                    setActor('');
                  }}
                >
                  <option value="" disabled>
                    {agents.isPending ? 'Loading…' : 'Choose an agent'}
                  </option>
                  {(agents.data ?? []).map((each) => (
                    <option key={each.id} value={each.id}>
                      {each.name}
                    </option>
                  ))}
                </select>
              </span>
            )}
          </Field>
        )}
        {type === 'actor' && (
          <Field label="Actor">
            {(id) => (
              <span className="select">
                <select
                  id={id}
                  className="ac-input"
                  required
                  disabled={agent === ''}
                  value={actor}
                  onChange={(event) => setActor(event.target.value)}
                >
                  <option value="" disabled>
                    {agent !== '' && actors.isPending ? 'Loading…' : 'Choose an actor'}
                  </option>
                  {(actors.data ?? []).map((each) => (
                    <option key={each.id} value={each.id}>
                      {each.name ?? each.id}
                    </option>
                  ))}
                </select>
              </span>
            )}
          </Field>
        )}
        <div className="ac-field">
          <span className="ac-field__label">Permissions</span>
          <div className="scopes">
            <fieldset className="scopes__product">
              {offered.map((permission) => (
                <label key={permission} className="check" title={PERMISSION_TEXT[permission]}>
                  <input
                    type="checkbox"
                    checked={ticked.has(permission)}
                    onChange={(event) => tick(permission, event.target.checked)}
                  />
                  <code>{permission}</code>
                  <span className="note">{PERMISSION_TEXT[permission]}</span>
                </label>
              ))}
            </fieldset>
          </div>
        </div>
        <Field label="Expires">
          {(id) => (
            <span className="select">
              <select
                id={id}
                className="ac-input"
                value={expiry}
                onChange={(event) => setExpiry(event.target.value as typeof expiry)}
              >
                {EXPIRIES.map((each) => (
                  <option key={each.value} value={each.value}>
                    {each.text}
                  </option>
                ))}
              </select>
            </span>
          )}
        </Field>
      </form>
    </Dialog>
  );
}

/** The new key, this once. */
export function KeyShown({ made, onDone }: { made: CreateKeyResponse; onDone: () => void }) {
  const line = `export ENGINE_API_KEY=${made.token}`;
  return (
    <Dialog
      title={made.key.label}
      onClose={onDone}
      wide
      footer={
        <Button variant="primary" onClick={onDone} data-autofocus>
          Done
        </Button>
      }
    >
      <div className="ac-field">
        <span className="ac-field__label">{SHOWN_ONCE}</span>
        <div className="secret-once">
          <code className="secret-once__value">{made.token}</code>
          <CopyButton value={made.token} what="key" text />
        </div>
      </div>
      <div className="ac-field">
        <span className="ac-field__label">Environment</span>
        <div className="secret-once">
          <code className="secret-once__value">{line}</code>
          <CopyButton value={line} what="line" text />
        </div>
      </div>
      <p className="note">It is not shown again.</p>
    </Dialog>
  );
}
