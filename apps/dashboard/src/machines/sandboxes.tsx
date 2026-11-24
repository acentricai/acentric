// `/sandboxes`: the engine's accounts at sandbox providers; `/sandboxes/$provider`: the
// sandboxes of one, made and deleted from here. A sandbox is a machine like any other.

import { IconArrowLeft, IconPlus, IconTrash } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useId, useState } from 'react';

import type { Sandbox, SandboxProviderAccount as Provider, SandboxState } from '@acentric/protocol';

import { queryClient } from '../api.ts';
import { agentsText, useAgentNames } from './agents.tsx';
import { engine } from './api.ts';
import { keys, useProviders, useSandboxes } from './queries.ts';
import { displayText, safeText } from './text.tsx';
import {
  Ago,
  Button,
  Confirm,
  Dialog,
  Field,
  FormError,
  LoadError,
  Menu,
  MenuItem,
  PageHeader,
  PathLink,
  Status,
  Table,
} from './ui.tsx';

import './machine-pane.css';

/**
 * A provider's ID for a sandbox, as the table shows it: Docker's are 64 hex digits, of which it
 * shows the first 12 itself. The whole is the cell's title.
 */
export const shortSandboxId = (id: string): string =>
  /^[0-9a-f]{64}$/.test(id) ? id.slice(0, 12) : id;

/** `/sandboxes`, and one account's page under it. */
export const sandboxesPath = (providerId?: string): string =>
  `/sandboxes${providerId === undefined ? '' : `/${encodeURIComponent(providerId)}`}`;

/** What each provider is called. Another is called by its own name for itself. */
const KINDS: Readonly<Record<string, string>> = { boat: 'Boat', docker: 'Docker' };
const kindText = (kind: string): string => KINDS[kind] ?? kind;

/** Boat's sizes, as `POST /v1/sandboxes` takes them. A Docker account takes them too. */
export const SIZES = [
  { vcpu: 2, memoryGB: 4 },
  { vcpu: 4, memoryGB: 8 },
  { vcpu: 8, memoryGB: 16 },
  { vcpu: 16, memoryGB: 32 },
] as const;
const sizeText = (s: { vcpu: number; memoryGB: number }) => `${s.vcpu} vCPU · ${s.memoryGB} GB`;

/** How long a sandbox may sit with no command before Boat stops it; a command wakes it. */
export const IDLE = [
  { seconds: 600, text: '10 minutes' },
  { seconds: 1800, text: '30 minutes' },
  { seconds: 3600, text: '1 hour' },
  { seconds: 14400, text: '4 hours' },
  { seconds: 86400, text: '1 day' },
  { seconds: 604800, text: '1 week' },
] as const;
const idleText = (seconds: number) =>
  IDLE.find((option) => option.seconds === seconds)?.text ??
  (seconds % 3600 === 0 ? `${seconds / 3600} h` : `${Math.round(seconds / 60)} min`);

/** `/sandboxes`: the provider accounts sandboxes are made in. */
export function ProvidersPage() {
  const providers = useProviders();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Provider | null>(null);
  return (
    <div className="list-page sandboxes-page">
      <PageHeader title="Sandboxes" spaced>
        <Button variant="primary" onClick={() => setAdding(true)}>
          <IconPlus size={15} />
          Add account
        </Button>
      </PageHeader>
      {(providers.isError || providers.failureReason !== null) && (
        <LoadError
          things="accounts"
          error={providers.error ?? providers.failureReason}
          retrying={providers.isFetching && providers.failureCount > 0}
          onRetry={() => void providers.refetch()}
        />
      )}
      <Table
        label="Accounts"
        loading={providers.isPending}
        rows={providers.data?.items}
        rowKey={(p) => p.id}
        columns={[
          {
            name: 'Name',
            cell: (p) => (
              <PathLink to={sandboxesPath(p.id)} className="ac-table__name title-link">
                {displayText(p.name)}
              </PathLink>
            ),
          },
          { name: 'Provider', cell: (p) => displayText(kindText(p.kind)) },
          {
            name: 'Account',
            cell: (p) =>
              p.account === null ? (
                <span className="ac-table__muted">—</span>
              ) : (
                displayText(p.account)
              ),
          },
          { name: 'Sandboxes', cell: (p) => <span className="ac-num">{p.sandboxes}</span> },
          { name: 'Added', cell: (p) => <Ago at={p.createdAt} /> },
          {
            name: 'Actions',
            hidden: true,
            className: 'ac-table__actions',
            cell: (p) => (
              <Menu label={`Actions for ${safeText(p.name)}`}>
                {(close) => (
                  <MenuItem
                    danger
                    icon={<IconTrash size={16} stroke={1.75} aria-hidden="true" />}
                    onSelect={() => {
                      close();
                      setRemoving(p);
                    }}
                  >
                    Remove
                  </MenuItem>
                )}
              </Menu>
            ),
          },
        ]}
      />
      {providers.data?.items.length === 0 && (
        <p className="table-empty">No accounts. Add a Boat account to make sandboxes from here.</p>
      )}
      {adding && <AddAccountDialog onClose={() => setAdding(false)} />}
      {removing && <RemoveAccount provider={removing} onClose={() => setRemoving(null)} />}
    </div>
  );
}

/** `POST /v1/providers`. The key is sent once and never shown again. */
function AddAccountDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const form = useId();
  const add = useMutation({
    mutationFn: () => engine.addProvider('boat', name.trim(), apiKey.trim()),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.providers });
      onClose();
    },
  });
  const ready = name.trim() !== '' && apiKey.trim() !== '';
  return (
    <Dialog
      title="Add account"
      pending={add.isPending}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" disabled={add.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={form}
            variant="primary"
            busy={add.isPending}
            disabled={!ready}
          >
            Add account
          </Button>
        </>
      }
    >
      <form
        id={form}
        className="dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !add.isPending) add.mutate();
        }}
      >
        <Field label="Provider">
          {(id) => (
            <span className="select">
              <select id={id} className="ac-input" value="boat" disabled>
                <option value="boat">Boat</option>
              </select>
            </span>
          )}
        </Field>
        <Field label="Name">
          {(id) => (
            <input
              id={id}
              className="ac-input"
              required
              maxLength={63}
              placeholder="personal"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field label="API key">
          {(id) => (
            <input
              id={id}
              className="ac-input"
              required
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="boat_…"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          )}
        </Field>
        <p className="note">
          Create one with <code>boat api-key create</code>. It needs to create, read, stop, resume
          and delete sandboxes, and read snapshots.
        </p>
      </form>
      <FormError error={add.error} />
    </Dialog>
  );
}

function RemoveAccount({ provider, onClose }: { provider: Provider; onClose: () => void }) {
  const remove = useMutation({
    mutationFn: () => engine.removeProvider(provider.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.providers });
      onClose();
    },
  });
  return (
    <Confirm
      title={`Remove ${provider.name}?`}
      sentence="The engine forgets this account and its API key. An account with sandboxes cannot be removed."
      action="Remove"
      danger
      pending={remove.isPending}
      onClose={onClose}
      onConfirm={() => remove.mutate()}
      {...(remove.error ? { error: remove.error.message } : {})}
    />
  );
}

const STATES: Record<SandboxState, string> = {
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  stopped: 'Stopped',
  error: 'Error',
  gone: 'Deleted',
  unknown: 'Unknown',
};

/** The daemon's connection first; the provider's state when it is not connected. */
function SandboxStatus({ sandbox }: { sandbox: Sandbox }) {
  const { machine, state } = sandbox;
  const word = machine.online
    ? 'Online'
    : state === 'running' || state === 'starting'
      ? 'Connecting'
      : STATES[state];
  return (
    <span className="machine-status">
      <Status word={word} tone={machine.online ? 'running' : 'idle'} />
      {!machine.online && machine.lastSeenAt !== null && (
        <span className="note">
          last seen <Ago at={machine.lastSeenAt} />
        </span>
      )}
    </span>
  );
}

/** `/sandboxes/$provider`: the sandboxes of one provider account. */
export function ProviderPage({ providerId }: { providerId: string }) {
  const providers = useProviders();
  const sandboxes = useSandboxes(providerId);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<Sandbox | null>(null);
  const names = useAgentNames();
  const provider = providers.data?.items.find((p) => p.id === providerId);
  return (
    <div className="list-page sandboxes-page">
      <p className="page__back rise">
        <PathLink to={sandboxesPath()} className="more">
          <IconArrowLeft size={14} stroke={1.75} aria-hidden="true" />
          Accounts
        </PathLink>
      </p>
      <PageHeader title={provider?.name ?? 'Sandboxes'} spaced>
        {provider && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            <IconPlus size={15} />
            Create sandbox
          </Button>
        )}
      </PageHeader>
      {(sandboxes.isError || sandboxes.failureReason !== null) && (
        <LoadError
          things="sandboxes"
          error={sandboxes.error ?? sandboxes.failureReason}
          retrying={sandboxes.isFetching && sandboxes.failureCount > 0}
          onRetry={() => void sandboxes.refetch()}
        />
      )}
      {!sandboxes.isError && (
        <Table
          label="Sandboxes"
          loading={sandboxes.isPending}
          rows={sandboxes.data?.items}
          rowKey={(s) => s.machine.id}
          columns={[
            {
              name: 'Machine',
              cell: (s) => (
                <span className="ac-table__name mono" title={s.machine.id}>
                  {displayText(s.machine.name)}
                </span>
              ),
            },
            { name: 'Status', cell: (s) => <SandboxStatus sandbox={s} /> },
            { name: 'Size', cell: (s) => sizeText(s) },
            { name: 'Agents', cell: (s) => displayText(agentsText(s.machine.agents, names)) },
            {
              name: `${provider ? kindText(provider.kind) : 'Provider'} ID`,
              cell: (s) =>
                s.providerSandboxId === null ? (
                  <span className="ac-table__muted">—</span>
                ) : (
                  <code title={s.providerSandboxId}>
                    {displayText(shortSandboxId(s.providerSandboxId))}
                  </code>
                ),
            },
            { name: 'Stops when idle', cell: (s) => idleText(s.idleTimeoutSeconds) },
            { name: 'Created', cell: (s) => <Ago at={s.machine.createdAt} /> },
            {
              name: 'Actions',
              hidden: true,
              className: 'ac-table__actions',
              cell: (s) => (
                <Menu label={`Actions for ${safeText(s.machine.name)}`}>
                  {(close) => (
                    <MenuItem
                      danger
                      icon={<IconTrash size={16} stroke={1.75} aria-hidden="true" />}
                      onSelect={() => {
                        close();
                        setRemoving(s);
                      }}
                    >
                      Delete
                    </MenuItem>
                  )}
                </Menu>
              ),
            },
          ]}
        />
      )}
      {sandboxes.data?.items.length === 0 && <p className="table-empty">No sandboxes</p>}
      {creating && provider && (
        <CreateSandboxDialog provider={provider} onClose={() => setCreating(false)} />
      )}
      {removing && (
        <DeleteSandboxDialog
          key={removing.machine.id}
          sandbox={removing}
          kind={provider?.kind}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
  );
}

/**
 * `POST /v1/sandboxes`: answered once the sandbox's daemon has connected, usually
 * within seconds, or after a minute with it still connecting.
 */
function CreateSandboxDialog({ provider, onClose }: { provider: Provider; onClose: () => void }) {
  const [size, setSize] = useState(1);
  const [idle, setIdle] = useState(3600);
  const [name, setName] = useState('');
  const form = useId();
  const create = useMutation({
    mutationFn: () =>
      engine.createSandbox({
        provider: provider.id,
        ...(SIZES[size] ?? SIZES[1]),
        idleTimeoutSeconds: idle,
        // For every agent, and any deployed later.
        agents: '*',
        ...(name.trim() === '' ? {} : { name: name.trim() }),
      }),
    onSuccess: () => {
      // A sandbox is a machine: every list of them changes.
      void queryClient.invalidateQueries({ queryKey: keys.all });
      onClose();
    },
  });
  return (
    <Dialog
      title="Create sandbox"
      pending={create.isPending}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" disabled={create.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={form} variant="primary" busy={create.isPending}>
            Create sandbox
          </Button>
        </>
      }
    >
      <form
        id={form}
        className="dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!create.isPending) create.mutate();
        }}
      >
        <Field label="Size">
          {(id) => (
            <span className="select">
              <select
                id={id}
                className="ac-input"
                value={size}
                disabled={create.isPending}
                onChange={(e) => setSize(Number(e.target.value))}
              >
                {SIZES.map((s, index) => (
                  <option key={index} value={index}>
                    {sizeText(s)}
                  </option>
                ))}
              </select>
            </span>
          )}
        </Field>
        <Field label="Stop when idle for">
          {(id) => (
            <span className="select">
              <select
                id={id}
                className="ac-input"
                value={idle}
                disabled={create.isPending}
                onChange={(e) => setIdle(Number(e.target.value))}
              >
                {IDLE.map((option) => (
                  <option key={option.seconds} value={option.seconds}>
                    {option.text}
                  </option>
                ))}
              </select>
            </span>
          )}
        </Field>
        <Field label="Name">
          {(id) => (
            <input
              id={id}
              className="ac-input mono"
              maxLength={63}
              placeholder="sandbox-…"
              spellCheck={false}
              disabled={create.isPending}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <p className="note" role={create.isPending ? 'status' : undefined}>
          {create.isPending ? (
            'Creating the sandbox and waiting for its daemon to connect…'
          ) : (
            <>
              Made in {displayText(provider.name)} from the engine's template. It becomes a machine
              actors can work on; a command sent while it is stopped wakes it.
            </>
          )}
        </p>
      </form>
      <FormError error={create.error} />
    </Dialog>
  );
}

/** `DELETE /v1/sandboxes/:machine`, after its exact name is typed. */
function DeleteSandboxDialog({
  sandbox,
  kind,
  onClose,
}: {
  sandbox: Sandbox;
  kind: string | undefined;
  onClose: () => void;
}) {
  const [confirmation, setConfirmation] = useState('');
  const remove = useMutation({
    mutationFn: () => engine.deleteSandbox(sandbox.machine.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.all });
      onClose();
    },
  });
  return (
    <Dialog
      title={`Delete ${sandbox.machine.name}?`}
      pending={remove.isPending}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" disabled={remove.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={confirmation !== sandbox.machine.name}
            busy={remove.isPending}
            onClick={() => remove.mutate()}
          >
            Delete sandbox
          </Button>
        </>
      }
    >
      <p className="note">{sandboxDeletion(kind)}</p>
      <Field label={`Type ${safeText(sandbox.machine.name)} to confirm`}>
        {(id) => (
          <input
            id={id}
            className="ac-input"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
          />
        )}
      </Field>
      <FormError error={remove.error} />
    </Dialog>
  );
}

/** What deleting a sandbox does, at its provider, by the provider's name where it is known. */
export const sandboxDeletion = (kind: string | undefined): string =>
  `This deletes the sandbox and its disk at ${kind === undefined ? 'its provider' : kindText(kind)} and disconnects its daemon. Commands still running on it are lost. It cannot be undone.`;
