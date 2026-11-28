// `/llm-providers`: the accounts model calls are made with, several of each provider. Each agent
// is given one of its provider's, or uses that provider's default. A key is checked with its
// provider when it is added or replaced, and never shown again. A ChatGPT account has no key: it
// is signed in with ChatGPT, and its calls are made on that ChatGPT plan. So is a Claude
// account, on a server that has Claude: signed in with Claude Code, on that Claude plan.

import { IconKey, IconLogin, IconPencil, IconPlus, IconStar, IconTrash } from '@tabler/icons-react';
import type { Account } from '@acentric/protocol';
import { useMutation } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { queryClient } from '../api.ts';
import { Dropdown } from '../ui.tsx';
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
import { SignInAgainDialog, SignInFlow } from './sign-in.tsx';
import {
  ADD_PROVIDERS,
  GATED_PROVIDERS,
  dollars,
  providerName,
  rangeStart,
  signsIn,
} from './format.ts';
import { keys, useAccounts, useModelProviders, useUsage } from './queries.ts';

import '../machines/machine-pane.css';
import './llm.css';

type Action = { kind: 'rename' | 'key' | 'sign-in' | 'remove'; provider: Account };

type AddProvider = (typeof ADD_PROVIDERS)[number];

const refresh = () => void queryClient.invalidateQueries({ queryKey: keys.all });

export function AccountsPage() {
  const providers = useAccounts();
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
                {p.signIn?.signedOut !== undefined && (
                  <span className="chip chip--warn" title={safeText(p.signIn.signedOut)}>
                    signed out
                  </span>
                )}
              </span>
            ),
          },
          {
            name: 'Provider',
            cell: (p) => (
              <span {...(p.signIn?.email == null ? {} : { title: safeText(p.signIn.email) })}>
                {providerName(p.provider)}
              </span>
            ),
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
                    {p.credential === 'api_key' ? (
                      <MenuItem
                        icon={<IconKey size={16} stroke={1.75} aria-hidden="true" />}
                        onSelect={() => {
                          close();
                          setAction({ kind: 'key', provider: p });
                        }}
                      >
                        Replace key
                      </MenuItem>
                    ) : (
                      <MenuItem
                        icon={<IconLogin size={16} stroke={1.75} aria-hidden="true" />}
                        onSelect={() => {
                          close();
                          setAction({ kind: 'sign-in', provider: p });
                        }}
                      >
                        Sign in again
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
      {action?.kind === 'sign-in' && (
        <SignInAgainDialog
          key={action.provider.id}
          account={action.provider}
          onClose={() => setAction(null)}
        />
      )}
      {action?.kind === 'remove' && (
        <RemoveDialog provider={action.provider} onClose={() => setAction(null)} />
      )}
    </div>
  );
}

/**
 * `POST /v1/accounts`, the key checked with the provider first and not shown again. Or, for
 * ChatGPT and Claude, a sign-in in place of the key: `POST /v1/chatgpt-sign-ins` or
 * `/v1/claude-sign-ins`. The first of a provider is its default; another is made it from the
 * list. Only the providers the server has are offered.
 */
function AddDialog({ onClose }: { onClose: () => void }) {
  const had = useModelProviders();
  const offered = ADD_PROVIDERS.filter((kind) =>
    had.data === undefined
      ? !GATED_PROVIDERS.includes(kind)
      : had.data.some((one) => one.id === kind),
  );
  const [provider, setProvider] = useState<AddProvider>('anthropic');
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
  // Signed in, not given a key.
  const signingInTo = signsIn(provider) ? provider : undefined;
  // While a sign-in waits, the name it was started with stays.
  const [signingIn, setSigningIn] = useState(false);
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
          {signingInTo === undefined && (
            <Button
              type="submit"
              form={form}
              variant="primary"
              busy={add.isPending}
              disabled={!ready}
            >
              Add account
            </Button>
          )}
        </>
      }
    >
      <form
        id={form}
        className="dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (signingInTo === undefined && ready && !add.isPending) add.mutate();
        }}
      >
        <div className="ac-field">
          <span className="ac-field__label">Provider</span>
          <Dropdown
            label="Provider"
            value={provider}
            options={offered.map((kind) => ({ value: kind, label: providerName(kind) }))}
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
              disabled={add.isPending || (signingInTo !== undefined && signingIn)}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        {signingInTo !== undefined ? (
          <SignInFlow
            key={signingInTo}
            provider={signingInTo}
            ask={() => ({ name: name.trim() })}
            ready={name.trim() !== ''}
            onActive={setSigningIn}
            onDone={onClose}
          />
        ) : (
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
        )}
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

function RemoveDialog({ provider, onClose }: { provider: Account; onClose: () => void }) {
  const remove = useMutation({
    mutationFn: () => engine.removeAccount(provider.id),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const held = provider.actors > 0;
  const secret = provider.credential === 'api_key' ? 'key' : 'sign-in';
  return (
    <Confirm
      title={`Remove ${provider.name}?`}
      sentence={
        held
          ? `${String(provider.actors)} ${provider.actors === 1 ? 'actor uses' : 'actors use'} it: archive or delete ${provider.actors === 1 ? 'it' : 'them'} first.`
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
