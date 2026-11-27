// `/sandboxes`: the engine's accounts at sandbox providers; `/sandboxes/$provider`: the
// sandboxes of one, made and deleted from here, and its templates. A sandbox is a machine like
// any other.

import { IconArrowLeft, IconFileText, IconPlus, IconTrash } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';

import type {
  Sandbox,
  SandboxProviderAccount as Provider,
  SandboxState,
  SandboxTemplate as Template,
  SandboxTemplateStatus,
} from '@acentric/protocol';

import { queryClient } from '../api.ts';
import { engine } from './api.ts';
import { keys, useProviders, useSandboxes, useTemplates } from './queries.ts';
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
          and delete sandboxes, run commands and write files in them, and save, read and delete
          snapshots.
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
      sentence="The engine forgets this account and its API key. An account with sandboxes or templates cannot be removed."
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

/** The tabs of an account's page. Templates only for a provider the engine builds them at. */
type ProviderTab = 'sandboxes' | 'templates';

/** `/sandboxes/$provider`: the sandboxes of one provider account, and its templates. */
export function ProviderPage({ providerId }: { providerId: string }) {
  const providers = useProviders();
  const provider = providers.data?.items.find((p) => p.id === providerId);
  const builds = provider?.kind === 'boat';
  const [chosen, setTab] = useState<ProviderTab>('sandboxes');
  const tab: ProviderTab = builds ? chosen : 'sandboxes';
  const sandboxes = useSandboxes(providerId);
  const templates = useTemplates(providerId, builds);
  const [creating, setCreating] = useState(false);
  const [building, setBuilding] = useState(false);
  const [removing, setRemoving] = useState<Sandbox | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Template | null>(null);
  const viewed = templates.data?.items.find((t) => t.id === viewing);
  return (
    <div className="list-page sandboxes-page">
      <p className="page__back rise">
        <PathLink to={sandboxesPath()} className="more">
          <IconArrowLeft size={14} stroke={1.75} aria-hidden="true" />
          Accounts
        </PathLink>
      </p>
      <PageHeader title={provider?.name ?? 'Sandboxes'} spaced={!builds}>
        {provider &&
          (tab === 'sandboxes' ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <IconPlus size={15} />
              Create sandbox
            </Button>
          ) : (
            <Button variant="primary" onClick={() => setBuilding(true)}>
              <IconPlus size={15} />
              Build template
            </Button>
          ))}
      </PageHeader>
      {builds && (
        <div className="provider-tabs rise" role="tablist" aria-label={safeText(provider.name)}>
          {(
            [
              ['sandboxes', 'Sandboxes'],
              ['templates', 'Templates'],
            ] as const
          ).map(([id, name]) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`provider-tab-${id}`}
              aria-selected={tab === id}
              aria-controls={`provider-panel-${id}`}
              className="provider-tabs__tab"
              onClick={() => setTab(id)}
            >
              {name}
            </button>
          ))}
        </div>
      )}
      <div
        {...(builds
          ? {
              role: 'tabpanel',
              id: `provider-panel-${tab}`,
              'aria-labelledby': `provider-tab-${tab}`,
            }
          : {})}
      >
        {tab === 'sandboxes' ? (
          <SandboxesTable sandboxes={sandboxes} provider={provider} onDelete={setRemoving} />
        ) : (
          <TemplatesTable
            templates={templates}
            onView={(t) => setViewing(t.id)}
            onDelete={setDeleting}
          />
        )}
      </div>
      {creating && provider && (
        <CreateSandboxDialog
          provider={provider}
          templates={builds ? (templates.data?.items ?? []) : []}
          onClose={() => setCreating(false)}
        />
      )}
      {building && provider && (
        <BuildTemplateDialog
          provider={provider}
          onClose={() => setBuilding(false)}
          onBuilt={(t) => setViewing(t.id)}
        />
      )}
      {viewed && <TemplateDialog template={viewed} onClose={() => setViewing(null)} />}
      {deleting && (
        <DeleteTemplate
          key={deleting.id}
          template={deleting}
          kind={provider?.kind}
          onClose={() => setDeleting(null)}
        />
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

function SandboxesTable({
  sandboxes,
  provider,
  onDelete,
}: {
  sandboxes: ReturnType<typeof useSandboxes>;
  provider: Provider | undefined;
  onDelete: (sandbox: Sandbox) => void;
}) {
  return (
    <>
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
                        onDelete(s);
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
    </>
  );
}

const TEMPLATE_STATES: Record<SandboxTemplateStatus, string> = {
  building: 'Building',
  ready: 'Ready',
  failed: 'Failed',
};

function TemplateStatus({ template }: { template: Template }) {
  return (
    <Status
      word={TEMPLATE_STATES[template.status]}
      tone={template.status === 'ready' ? 'running' : 'idle'}
    />
  );
}

function TemplatesTable({
  templates,
  onView,
  onDelete,
}: {
  templates: ReturnType<typeof useTemplates>;
  onView: (template: Template) => void;
  onDelete: (template: Template) => void;
}) {
  return (
    <>
      {(templates.isError || templates.failureReason !== null) && (
        <LoadError
          things="templates"
          error={templates.error ?? templates.failureReason}
          retrying={templates.isFetching && templates.failureCount > 0}
          onRetry={() => void templates.refetch()}
        />
      )}
      {!templates.isError && (
        <Table
          label="Templates"
          loading={templates.isPending}
          rows={templates.data?.items}
          rowKey={(t) => t.id}
          columns={[
            {
              name: 'Name',
              cell: (t) => (
                <button
                  type="button"
                  className="ac-table__name title-link template-name"
                  onClick={() => onView(t)}
                >
                  {displayText(t.name)}
                </button>
              ),
            },
            { name: 'Status', cell: (t) => <TemplateStatus template={t} /> },
            { name: 'Created', cell: (t) => <Ago at={t.createdAt} /> },
            {
              name: 'Actions',
              hidden: true,
              className: 'ac-table__actions',
              cell: (t) => (
                <Menu label={`Actions for ${safeText(t.name)}`}>
                  {(close) => (
                    <>
                      <MenuItem
                        icon={<IconFileText size={16} stroke={1.75} aria-hidden="true" />}
                        onSelect={() => {
                          close();
                          onView(t);
                        }}
                      >
                        View
                      </MenuItem>
                      <MenuItem
                        danger
                        icon={<IconTrash size={16} stroke={1.75} aria-hidden="true" />}
                        onSelect={() => {
                          close();
                          onDelete(t);
                        }}
                      >
                        Delete
                      </MenuItem>
                    </>
                  )}
                </Menu>
              ),
            },
          ]}
        />
      )}
      {templates.data?.items.length === 0 && <p className="table-empty">No templates</p>}
    </>
  );
}

/** `POST /v1/providers/:provider/templates`: answered at once, while it builds. */
function BuildTemplateDialog({
  provider,
  onClose,
  onBuilt,
}: {
  provider: Provider;
  onClose: () => void;
  onBuilt: (template: Template) => void;
}) {
  const [name, setName] = useState('');
  const [script, setScript] = useState('');
  const form = useId();
  const build = useMutation({
    mutationFn: () => engine.buildTemplate(provider.id, name.trim(), script),
    onSuccess: (template) => {
      void queryClient.invalidateQueries({ queryKey: keys.templates(provider.id) });
      onClose();
      onBuilt(template);
    },
  });
  const ready = name.trim() !== '' && script.trim() !== '';
  return (
    <Dialog
      title="Build template"
      wide
      pending={build.isPending}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" disabled={build.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={form}
            variant="primary"
            busy={build.isPending}
            disabled={!ready}
          >
            Build template
          </Button>
        </>
      }
    >
      <form
        id={form}
        className="dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !build.isPending) build.mutate();
        }}
      >
        <Field label="Name">
          {(id) => (
            <input
              id={id}
              className="ac-input mono"
              required
              maxLength={63}
              spellCheck={false}
              placeholder="with-node"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field label="Script">
          {(id) => (
            <textarea
              id={id}
              className="ac-input mono template-script"
              required
              rows={12}
              spellCheck={false}
              placeholder={'sudo apt-get update\nsudo apt-get install -y jq'}
              value={script}
              onChange={(e) => setScript(e.target.value)}
            />
          )}
        </Field>
      </form>
      <FormError error={build.error} />
    </Dialog>
  );
}

/** A template: how its build stands, its script, and what the build printed, read as it builds. */
function TemplateDialog({ template, onClose }: { template: Template; onClose: () => void }) {
  // Its newest output is kept in view: where a build is, or where it ended.
  const output = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const pre = output.current;
    if (pre !== null) pre.scrollTop = pre.scrollHeight;
  }, [template.output]);
  return (
    <Dialog title={template.name} wide onClose={onClose}>
      <div className="template-view">
        <p className="template-view__status">
          <TemplateStatus template={template} />
          {template.finishedAt !== null && (
            <span className="note">
              <Ago at={template.finishedAt} />
            </span>
          )}
        </p>
        {template.error !== null && (
          <p className="template-view__error">{displayText(template.error)}</p>
        )}
        <section className="ac-field">
          <h3 className="ac-field__label">Script</h3>
          <div className="json">
            <pre className="json__code" dir="ltr">
              {displayText(template.script, true)}
            </pre>
          </div>
        </section>
        <section className="ac-field">
          <h3 className="ac-field__label">Output</h3>
          <div className="json">
            <pre ref={output} className="json__code template-output" dir="ltr">
              {template.output === ''
                ? template.status === 'building'
                  ? 'Starting…'
                  : '—'
                : displayText(template.output, true)}
            </pre>
          </div>
        </section>
      </div>
    </Dialog>
  );
}

function DeleteTemplate({
  template,
  kind,
  onClose,
}: {
  template: Template;
  kind: string | undefined;
  onClose: () => void;
}) {
  const remove = useMutation({
    mutationFn: () => engine.deleteTemplate(template.provider, template.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.templates(template.provider) });
      onClose();
    },
  });
  return (
    <Confirm
      title={`Delete ${template.name}?`}
      sentence={`This deletes the template at ${kind === undefined ? 'its provider' : kindText(kind)}${template.status === 'building' ? ' and stops its build' : ''}. Sandboxes made from it are kept.`}
      action="Delete"
      danger
      pending={remove.isPending}
      onClose={onClose}
      onConfirm={() => remove.mutate()}
      {...(remove.error ? { error: remove.error.message } : {})}
    />
  );
}

/**
 * `POST /v1/sandboxes`: answered once the sandbox's daemon has connected, usually
 * within seconds, or after a minute with it still connecting.
 */
function CreateSandboxDialog({
  provider,
  templates,
  onClose,
}: {
  provider: Provider;
  templates: readonly Template[];
  onClose: () => void;
}) {
  const [size, setSize] = useState(1);
  const [idle, setIdle] = useState(3600);
  const [name, setName] = useState('');
  const ready = templates.filter((t) => t.status === 'ready');
  const [template, setTemplate] = useState('');
  const from = ready.find((t) => t.id === template);
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
        ...(from === undefined ? {} : { template: from.id }),
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
        {ready.length > 0 && (
          <Field label="Template">
            {(id) => (
              <span className="select">
                <select
                  id={id}
                  className="ac-input"
                  value={template}
                  disabled={create.isPending}
                  onChange={(e) => setTemplate(e.target.value)}
                >
                  <option value="">The engine's template</option>
                  {ready.map((t) => (
                    <option key={t.id} value={t.id}>
                      {safeText(t.name)}
                    </option>
                  ))}
                </select>
              </span>
            )}
          </Field>
        )}
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
              Made in {displayText(provider.name)} from{' '}
              {from === undefined ? "the engine's template" : displayText(from.name)}. It becomes a
              machine actors can work on; a command sent while it is stopped wakes it.
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
