// An agent's settings, as rows the way Settings has them: what it is, the model account its
// calls are made with, and deleting it.

import type { Agent } from '@acentric/protocol';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';

import { fullTime } from '../../format.ts';
import { Button, CopyButton, LoadError, PageHeader } from '../../machines/ui.tsx';
import { may, useMe } from '../../me.ts';
import { Dropdown, ErrorToast, Skeleton } from '../../ui.tsx';
import { engine, queryClient } from '../api.ts';
import { keys, useAgent } from '../queries.ts';
import { DeleteAgent } from './agents.tsx';
import '../agents.css';

/** A row: what it is, beside its value or what changes it. */
function Row({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="prefs-row">
      <div className="prefs-row__text">
        <span className="prefs-row__name">{name}</span>
      </div>
      <div className="prefs-row__value">{children}</div>
    </div>
  );
}

export function SettingsPage() {
  const { agent: id } = useParams({ strict: false }) as { agent: string };
  const agent = useAgent(id);
  const me = useMe();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  // Only one who deploys agents deletes one, or chooses its account.
  const deploys = me.data !== undefined && may(me.data, 'agents:deploy');

  return (
    <div className="list-page agent-settings">
      <PageHeader title="Settings" spaced />
      {agent.isError ? (
        <LoadError things="the agent" error={agent.error} onRetry={() => void agent.refetch()} />
      ) : agent.data === undefined ? (
        <Skeleton rows={4} label="Loading the agent" />
      ) : (
        <div className="prefs-page">
          <section className="prefs-group" aria-labelledby="agent-general">
            <h3 className="prefs-group__title" id="agent-general">
              General
            </h3>
            <Row name="Name">
              <span className="prefs-row__plain mono">{agent.data.name}</span>
            </Row>
            <Row name="ID">
              <span className="agent-settings__id">
                <span className="prefs-row__plain mono">{agent.data.id}</span>
                <CopyButton value={agent.data.id} what="the agent's ID" />
              </span>
            </Row>
            <Row name="Provider">
              <span className="prefs-row__plain mono">{agent.data.provider}</span>
            </Row>
            <Row name="Created">
              <span className="prefs-row__plain">{fullTime(agent.data.createdAt)}</span>
            </Row>
          </section>
          <section className="prefs-group" aria-labelledby="agent-model">
            <h3 className="prefs-group__title" id="agent-model">
              Model
            </h3>
            <Row name="Account">
              <AccountChoice agent={agent.data} />
            </Row>
          </section>
          {deploys && (
            <section className="prefs-group" aria-labelledby="agent-delete">
              <h3 className="prefs-group__title" id="agent-delete">
                Danger zone
              </h3>
              <Row name="Delete agent">
                <Button variant="danger" onClick={() => setDeleting(true)}>
                  Delete agent
                </Button>
              </Row>
            </section>
          )}
        </div>
      )}
      {deleting && agent.data !== undefined && (
        <DeleteAgent
          agent={agent.data}
          onClose={() => setDeleting(false)}
          onDeleted={() => void navigate({ to: '/agents' })}
        />
      )}
    </div>
  );
}

/**
 * The model account its calls are made with: one of its provider's, or that provider's default.
 * Chosen by one who deploys agents and manages accounts, who alone may list the accounts.
 */
function AccountChoice({ agent }: { agent: Agent }) {
  const me = useMe();
  const manages =
    me.data !== undefined && may(me.data, 'accounts:manage') && may(me.data, 'agents:deploy');
  const accounts = useQuery({
    queryKey: ['accounts', 'list'],
    queryFn: () => engine.accounts(),
    enabled: manages,
  });
  const assign = useMutation({
    mutationFn: (account: string | null) => engine.assignAccount(agent.id, account),
    onSuccess: (updated) => {
      queryClient.setQueryData(keys.agent(agent.id), updated);
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
  if (!manages) {
    return (
      <span className="prefs-row__plain mono">{agent.account ?? 'Its provider’s default'}</span>
    );
  }
  if (accounts.data === undefined) {
    return (
      <Dropdown label="Account" value="" options={[]} onChange={() => {}} placeholder="Loading…" />
    );
  }
  const own = accounts.data.items.filter((one) => one.provider === agent.provider);
  if (own.length === 0) {
    return (
      <Link to={'/llm-providers' as never} className="prefs-row__plain">
        No {agent.provider} account: add one
      </Link>
    );
  }
  const fallback = own.find((one) => one.default);
  const options = [
    { value: '', label: fallback === undefined ? 'Default: none' : `Default: ${fallback.name}` },
    ...own.map((one) => ({ value: one.id as string, label: one.name })),
  ];
  return (
    <>
      <Dropdown
        label="Account"
        value={agent.account ?? ''}
        options={options}
        onChange={(value) => assign.mutate(value === '' ? null : value)}
      />
      <ErrorToast error={assign.error} />
    </>
  );
}
