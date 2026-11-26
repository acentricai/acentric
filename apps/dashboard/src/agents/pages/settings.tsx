// An agent's settings, as rows the way Settings has them: what it is, and deleting it. Its
// actors have the model accounts: an agent is of a provider, not of an account.

import { useNavigate, useParams } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';

import { fullTime } from '../../format.ts';
import { Button, CopyButton, LoadError, PageHeader } from '../../machines/ui.tsx';
import { may, useMe } from '../../me.ts';
import { Skeleton } from '../../ui.tsx';
import { useAgent } from '../queries.ts';
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
