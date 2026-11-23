// The engine's agents: the landing page.

import type { Agent } from '@acentric/protocol';
import { IconAlertTriangle, IconRefresh, IconTrash } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type ComponentProps, type ReactNode } from 'react';

import { version } from '../../format.ts';
import { may, useMe } from '../../me.ts';
import {
  Ago,
  Button,
  Command,
  Dialog,
  Field,
  FormError,
  Menu,
  MenuItem,
  PageHeader,
  Table,
  errorText,
  type Column,
} from '../../ui.tsx';
import { engine, isApiError, queryClient, shellQuote } from '../api.ts';
import { AgentLink, agentPath } from '../links.tsx';
import { useAgents } from '../queries.ts';
import '../agents.css';

const columns: Column<Agent>[] = [
  {
    name: 'Name',
    cell: (agent) => (
      <div className="ac-table__primary">
        <AgentLink agent={agent.id} className="ac-table__name title-link">
          {agent.name}
        </AgentLink>
      </div>
    ),
  },
  {
    name: 'Version',
    cell: (agent) => <span className="mono">{version(agent.latestDeployment.version)}</span>,
  },
  { name: 'Provider', cell: (agent) => <span className="mono agent-model">{agent.provider}</span> },
  { name: 'Created', cell: (agent) => <Ago at={agent.createdAt} /> },
];

/**
 * The commands that deploy the first agent: sign in to this engine, start a project, and deploy
 * it. The key is asked for by the command, never written in.
 */
export function firstCommands(origin: string): string[] {
  return [`acentric login ${shellQuote(origin)}`, 'acentric init my-agents', 'acentric deploy'];
}

/** The shared table with the reference's empty row, retaining the column headings. */
export function AgentTable<T>({
  empty,
  ...props
}: ComponentProps<typeof Table<T>> & { empty: ReactNode }) {
  if (props.rows?.length !== 0) return <Table {...props} />;
  return (
    <div className="ac-table-wrap">
      <table
        className={`ac-table${props.className === undefined ? '' : ` ${props.className}`}`}
        aria-label={props.label}
        aria-busy={props.loading}
      >
        <thead>
          <tr>
            {props.columns.map((column) => (
              <th key={column.name} scope="col" className={column.className}>
                {column.hidden === true ? (
                  <span className="visually-hidden">{column.name}</span>
                ) : (
                  column.name
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td colSpan={props.columns.length}>
              <div className="agent-table-empty">{empty}</div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** The reference's error frame, with labels and the API's text only. */
export function AgentLoadError({
  error,
  title,
  onRetry,
  compact = false,
}: {
  error: unknown;
  title: string;
  onRetry: () => void;
  compact?: boolean;
}) {
  const missing = isApiError(error, 404);
  return (
    <div className={`state-error${compact ? ' state-error--compact' : ''}`} role="alert">
      <IconAlertTriangle size={18} stroke={1.75} aria-hidden="true" />
      <div>
        <p className="state-error__title">{missing ? 'Not found' : title}</p>
        {!missing && <p className="note">{errorText(error)}</p>}
      </div>
      {!missing && (
        <Button size="sm" onClick={onRetry}>
          <IconRefresh size={14} stroke={1.75} aria-hidden="true" />
          Retry
        </Button>
      )}
    </div>
  );
}

export function AgentsPage() {
  const navigate = useNavigate();
  const agents = useAgents();
  const me = useMe();
  const [deleting, setDeleting] = useState<Agent | null>(null);
  const rows = agents.data?.items;
  const empty = rows !== undefined && rows.length === 0;
  // Only a person who deploys agents may delete one.
  const mayDelete = me.data !== undefined && may(me.data, 'agents:deploy');
  const shown: Column<Agent>[] = mayDelete
    ? [
        ...columns,
        {
          name: 'Actions',
          hidden: true,
          className: 'ac-table__actions',
          cell: (agent) => (
            <Menu label={`Actions for ${agent.name}`} variant="more" align="end">
              {(close) => (
                <MenuItem
                  danger
                  icon={<IconTrash size={16} stroke={1.75} aria-hidden="true" />}
                  onSelect={() => {
                    close();
                    setDeleting(agent);
                  }}
                >
                  Delete
                </MenuItem>
              )}
            </Menu>
          ),
        },
      ]
    : columns;

  return (
    <div className="list-page agents-page">
      <PageHeader title="Agents" spaced />
      {agents.isError && (
        <AgentLoadError error={agents.error} title="Agents" onRetry={() => void agents.refetch()} />
      )}
      {empty ? (
        <div className="agent-commands rise">
          <p className="note">No agents yet. Start a project of agents, then deploy it:</p>
          {firstCommands(location.origin).map((command) => (
            <Command key={command} text={command} />
          ))}
        </div>
      ) : (
        !(agents.isError && rows === undefined) && (
          <div className="rise">
            <AgentTable
              label="Agents"
              className="agents-list"
              columns={shown}
              rows={rows}
              rowKey={(agent) => agent.id}
              loading={agents.isPending}
              empty="No agents"
              onRow={(agent) => void navigate({ to: agentPath(agent.id) })}
            />
          </div>
        )
      )}
      {deleting !== null && (
        <DeleteAgent key={deleting.id} agent={deleting} onClose={() => setDeleting(null)} />
      )}
    </div>
  );
}

/** Deletes an agent with its actors, once its name is typed. */
function DeleteAgent({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const [confirmation, setConfirmation] = useState('');
  const remove = useMutation({
    mutationFn: () => engine.deleteAgent(agent.id),
    onSuccess: () => {
      // Its actors go from every list, and from the machines it was on.
      void queryClient.invalidateQueries();
      onClose();
    },
  });
  return (
    <Dialog
      title={`Delete ${agent.name}?`}
      onClose={() => {
        if (!remove.isPending) onClose();
      }}
      footer={
        <>
          <Button variant="quiet" disabled={remove.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={confirmation !== agent.name}
            busy={remove.isPending}
            onClick={() => remove.mutate()}
          >
            Delete agent
          </Button>
        </>
      }
    >
      <p className="note">
        Its actors are stopped, and its deployments, its actors and their conversations are removed,
        with its secrets. What they spent is kept, and machines are no longer for it. Its name is
        free: an agent deployed under it starts afresh.
      </p>
      <Field label={`Type ${agent.name} to confirm`}>
        {(id) => (
          <input
            id={id}
            className="ac-input"
            value={confirmation}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setConfirmation(event.target.value)}
          />
        )}
      </Field>
      <FormError error={remove.error} />
    </Dialog>
  );
}
