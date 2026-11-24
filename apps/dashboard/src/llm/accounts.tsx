// `/llm-providers`: the accounts model calls are made with, several of each provider. Each agent
// is given one of its provider's, or uses that provider's default. A key is checked with its
// provider when it is added or replaced, and never shown again.

import { IconKey, IconPencil, IconPlus, IconStar, IconTrash } from '@tabler/icons-react';
import type { Account } from '@acentric/protocol';
import { useMutation } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { queryClient } from '../api.ts';
import { Dropdown } from '../ui.tsx';
import { useAgentNames } from '../machines/agents.tsx';
import { displayText, safeText } from '../machines/text.tsx';
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
  Table,
} from '../machines/ui.tsx';
import { engine } from './api.ts';
import { dollars, KEY_PROVIDERS, providerName, rangeStart } from './format.ts';
import { keys, useAccounts, useUsage } from './queries.ts';

import '../machines/machine-pane.css';
import './llm.css';

type Action = { kind: 'rename' | 'key' | 'remove'; provider: Account };

type KeyProvider = (typeof KEY_PROVIDERS)[number];

const refresh = () => void queryClient.invalidateQueries({ queryKey: keys.all });

/** The agents an account was given, by name where it is known. */
const agentsOf = (p: Account, names: ReadonlyMap<string, string>): string[] =>
  p.agents.map((agent) => names.get(agent) ?? agent);

export function AccountsPage() {
  const providers = useAccounts();
  const names = useAgentNames();
  // What each spent in the last 30 days, beside it.
  const spent = useUsage({ by: 'account', from: rangeStart(30) });
  const costOf = new Map((spent.data?.groups ?? []).map((group) => [group.key, group.cost]));
  const [adding, setAdding] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const makeDefault = useMutation({
    mutationFn: (id: string) => engine.updateAccount(id, { default: true }),
    onSuccess: refresh,
  });
  const rows = providers.data;

  return (
    <div className="list-page llm-page">
      <PageHeader title="LLM providers" spaced>
        <Button variant="primary" onClick={() => setAdding(true)}>
          <IconPlus size={15} />
          Add account
        </Button>
      </PageHeader>
      {(providers.isError || providers.failureReason !== null) && (
        <LoadError
          things="LLM providers"
          error={providers.error ?? providers.failureReason}
          retrying={providers.isFetching && providers.failureCount > 0}
          onRetry={() => void providers.refetch()}
        />
      )}
      <Table
        label="LLM providers"
        loading={providers.isPending}
        rows={rows}
        rowKey={(p) => p.id}
        columns={[
          {
            name: 'Name',
            cell: (p) => (
              <span className="llm-name">
                <span className="ac-table__name">{displayText(p.name)}</span>
                {p.default && <span className="chip">default</span>}
              </span>
            ),
          },
          { name: 'Provider', cell: (p) => <span>{providerName(p.provider)}</span> },
          {
            name: 'Agents',
            cell: (p) => {
              const given = agentsOf(p, names);
              return given.length === 0 ? (
                <span className="ac-table__muted">
                  {p.default ? 'Every agent given none' : '—'}
                </span>
              ) : (
                <span title={given.join(', ')}>
                  {displayText(given.slice(0, 3).join(', '))}
                  {given.length > 3 ? ` and ${String(given.length - 3)} more` : ''}
                  {p.default ? ', and every agent given none' : ''}
                </span>
              );
            },
          },
          {
            name: 'Last 30 days',
            className: 'ac-table__num',
            cell: (p) => <span className="ac-num">{dollars(costOf.get(p.id) ?? 0)}</span>,
          },
          { name: 'Added', cell: (p) => <Ago at={p.createdAt} /> },
          {
            name: 'Actions',
            hidden: true,
            className: 'ac-table__actions',
            cell: (p) => (
              <Menu label={`Actions for ${safeText(p.name)}`}>
                {(close) => (
                  <>
                    {!p.default && (
                      <MenuItem
                        icon={<IconStar size={16} stroke={1.75} aria-hidden="true" />}
                        onSelect={() => {
                          close();
                          makeDefault.mutate(p.id);
                        }}
                      >
                        Make default
                      </MenuItem>
                    )}
                    <MenuItem
                      icon={<IconPencil size={16} stroke={1.75} aria-hidden="true" />}
                      onSelect={() => {
                        close();
                        setAction({ kind: 'rename', provider: p });
                      }}
                    >
                      Rename
                    </MenuItem>
                    {p.credential === 'api_key' && (
                      <MenuItem
                        icon={<IconKey size={16} stroke={1.75} aria-hidden="true" />}
                        onSelect={() => {
                          close();
                          setAction({ kind: 'key', provider: p });
                        }}
                      >
                        Replace key
                      </MenuItem>
                    )}
                    <MenuItem
                      danger
                      icon={<IconTrash size={16} stroke={1.75} aria-hidden="true" />}
                      onSelect={() => {
                        close();
                        setAction({ kind: 'remove', provider: p });
                      }}
                    >
                      Remove
                    </MenuItem>
                  </>
                )}
              </Menu>
            ),
          },
        ]}
      />
      {rows?.length === 0 && <p className="table-empty">No accounts yet</p>}
      <FormError error={makeDefault.error} />
      {adding && <AddDialog onClose={() => setAdding(false)} />}
      {action?.kind === 'rename' && (
        <RenameDialog
          key={action.provider.id}
          provider={action.provider}
          onClose={() => setAction(null)}
        />
      )}
      {action?.kind === 'key' && (
        <KeyDialog
          key={action.provider.id}
          provider={action.provider}
          onClose={() => setAction(null)}
        />
      )}
      {action?.kind === 'remove' && (
        <RemoveDialog provider={action.provider} names={names} onClose={() => setAction(null)} />
      )}
    </div>
  );
}

/**
 * `POST /v1/accounts`, the key checked with the provider first and not shown again. The first of
 * a provider is its default; another is made it from the list.
 */
function AddDialog({ onClose }: { onClose: () => void }) {
  const [provider, setProvider] = useState<KeyProvider>('anthropic');
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const form = useId();
  const add = useMutation({
    mutationFn: () =>
      engine.addAccount({
        provider,
        name: name.trim(),
        apiKey: apiKey.trim(),
      }),
    onSuccess: () => {
      refresh();
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
        <div className="ac-field">
          <span className="ac-field__label">Provider</span>
          <Dropdown
            label="Provider"
            value={provider}
            options={KEY_PROVIDERS.map((kind) => ({ value: kind, label: providerName(kind) }))}
            onChange={setProvider}
          />
        </div>
        <Field label="Name">
          {(id) => (
            <input
              id={id}
              className="ac-input"
              required
              maxLength={64}
              placeholder={`${provider}-personal`}
              disabled={add.isPending}
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
              disabled={add.isPending}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          )}
        </Field>
      </form>
      <FormError error={add.error} />
    </Dialog>
  );
}

function RenameDialog({ provider, onClose }: { provider: Account; onClose: () => void }) {
  const [name, setName] = useState(provider.name);
  const form = useId();
  const rename = useMutation({
    mutationFn: () => engine.updateAccount(provider.id, { name: name.trim() }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  return (
    <Dialog
      title="Rename account"
      pending={rename.isPending}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" disabled={rename.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={form}
            variant="primary"
            busy={rename.isPending}
            disabled={!name.trim()}
          >
            Save
          </Button>
        </>
      }
    >
      <form
        id={form}
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && !rename.isPending) rename.mutate();
        }}
      >
        <Field label="Name">
          {(id) => (
            <input
              id={id}
              required
              maxLength={64}
              className="ac-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
      </form>
      <FormError error={rename.error} />
    </Dialog>
  );
}

/** `PATCH /v1/accounts/:id { apiKey }`: checked first; the old key works until it is. */
function KeyDialog({ provider, onClose }: { provider: Account; onClose: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const form = useId();
  const replace = useMutation({
    mutationFn: () => engine.updateAccount(provider.id, { apiKey: apiKey.trim() }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  return (
    <Dialog
      title={`Replace the key of ${provider.name}`}
      pending={replace.isPending}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" disabled={replace.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={form}
            variant="primary"
            busy={replace.isPending}
            disabled={!apiKey.trim()}
          >
            Replace key
          </Button>
        </>
      }
    >
      <form
        id={form}
        className="dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (apiKey.trim() && !replace.isPending) replace.mutate();
        }}
      >
        <Field label="API key">
          {(id) => (
            <input
              id={id}
              required
              type="password"
              autoComplete="off"
              spellCheck={false}
              className="ac-input"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          )}
        </Field>
        <p className="note">
          Checked with {providerName(provider.provider)} first: the key now in use stays until the
          new one is taken.
        </p>
      </form>
      <FormError error={replace.error} />
    </Dialog>
  );
}

function RemoveDialog({
  provider,
  names,
  onClose,
}: {
  provider: Account;
  names: ReadonlyMap<string, string>;
  onClose: () => void;
}) {
  const remove = useMutation({
    mutationFn: () => engine.removeAccount(provider.id),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const held = provider.agents.length > 0;
  const secret = provider.credential === 'api_key' ? 'key' : 'sign-in';
  return (
    <Confirm
      title={`Remove ${provider.name}?`}
      sentence={
        held
          ? `It is given to ${agentsOf(provider, names).join(', ')}: give them another account first.`
          : provider.default
            ? `The engine forgets this account and its ${secret}. Another ${providerName(provider.provider)} account, if there is one, becomes the default. What was spent with it stays in Usage.`
            : `The engine forgets this account and its ${secret}. What was spent with it stays in Usage.`
      }
      action="Remove"
      danger
      pending={remove.isPending}
      onClose={onClose}
      onConfirm={() => remove.mutate()}
      {...(remove.error ? { error: remove.error.message } : {})}
    />
  );
}
