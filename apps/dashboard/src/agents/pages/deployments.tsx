// An agent's deployments, newest first: which is active, what each declared when it was
// deployed, opened by its version, and from each one's menu its code and making it active.

import type { DeploymentSummary } from '@acentric/protocol';
import { IconCircleCheck, IconCode } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useState } from 'react';

import { version } from '../../format.ts';
import {
  Ago,
  Confirm,
  CopyButton,
  Dialog,
  LoadError,
  Menu,
  MenuItem,
  PageHeader,
  Table,
  errorText,
} from '../../machines/ui.tsx';
import { may, useMe } from '../../me.ts';
import { Label } from '../../ui.tsx';
import { engine, queryClient } from '../api.ts';
import { agentPath } from '../links.tsx';
import { useAgent, useDeploymentCode, useDeployments } from '../queries.ts';
import type { DeploymentsSearch } from '../url.ts';
import { Declares } from './agent.tsx';
import '../../machines/machine-pane.css';
import '../agents.css';

type Action = { kind: 'source' | 'activate'; deployment: DeploymentSummary };

export function DeploymentsPage() {
  const { agent } = useParams({ strict: false }) as { agent: string };
  const search = useSearch({ strict: false }) as DeploymentsSearch;
  const navigate = useNavigate();
  const me = useMe();
  const detail = useAgent(agent);
  const deployments = useDeployments(agent);
  const [action, setAction] = useState<Action | null>(null);
  const rows = deployments.data?.items;
  const active = detail.data?.activeDeployment.version;
  // Only one who deploys the agent chooses which of its versions is active.
  const deploys = me.data !== undefined && may(me.data, 'agents:deploy');
  const opened = rows?.find((deployment) => deployment.version === search.v);
  // The open one is in the address, so it can be linked to and survives a reload.
  const show = (v: number | undefined) =>
    void navigate({
      to: agentPath(agent, 'deployments'),
      search: { v } as never,
      replace: true,
    });

  return (
    <div className="list-page deployments-page">
      <PageHeader title="Deployments" spaced />
      {deployments.isError && (
        <LoadError
          things="deployments"
          error={deployments.error}
          onRetry={() => void deployments.refetch()}
        />
      )}
      {!(deployments.isError && rows === undefined) && (
        <Table<DeploymentSummary>
          label="Deployments"
          loading={deployments.isPending}
          rows={rows}
          rowKey={(deployment) => deployment.id}
          columns={[
            {
              name: 'Version',
              cell: (deployment) => (
                <span className="deployment-version">
                  <button
                    type="button"
                    className="ac-table__name mono deployment-version__open"
                    onClick={() => show(deployment.version)}
                  >
                    {version(deployment.version)}
                  </button>
                  {deployment.version === active && <Label>active</Label>}
                </span>
              ),
            },
            {
              name: 'Hash',
              cell: (deployment) => (
                <span className="mono ac-table__muted" title={deployment.hash}>
                  {deployment.hash.slice(0, 12)}
                </span>
              ),
            },
            { name: 'Deployed', cell: (deployment) => <Ago at={deployment.createdAt} /> },
            {
              name: 'Actions',
              hidden: true,
              className: 'ac-table__actions',
              cell: (deployment) => (
                <Menu label={`Actions for ${version(deployment.version)}`}>
                  {(done) => (
                    <>
                      <MenuItem
                        icon={<IconCode size={16} stroke={1.75} aria-hidden="true" />}
                        onSelect={() => {
                          done();
                          setAction({ kind: 'source', deployment });
                        }}
                      >
                        View source
                      </MenuItem>
                      {deploys && active !== undefined && deployment.version !== active && (
                        <MenuItem
                          icon={<IconCircleCheck size={16} stroke={1.75} aria-hidden="true" />}
                          onSelect={() => {
                            done();
                            setAction({ kind: 'activate', deployment });
                          }}
                        >
                          Make active
                        </MenuItem>
                      )}
                    </>
                  )}
                </Menu>
              ),
            },
          ]}
        />
      )}
      {opened !== undefined && (
        <Dialog title={version(opened.version)} wide onClose={() => show(undefined)}>
          <div className="deployment-facts">
            <Declares agent={agent} deployment={opened.id} />
          </div>
        </Dialog>
      )}
      {action?.kind === 'source' && (
        <Source
          key={action.deployment.id}
          agent={agent}
          deployment={action.deployment}
          onClose={() => setAction(null)}
        />
      )}
      {action?.kind === 'activate' && active !== undefined && (
        <Activate
          key={action.deployment.id}
          agent={agent}
          deployment={action.deployment}
          active={active}
          onClose={() => setAction(null)}
        />
      )}
    </div>
  );
}

/** A version's code, as it was deployed: the one module its bundle made, with a copy button. */
function Source({
  agent,
  deployment,
  onClose,
}: {
  agent: string;
  deployment: DeploymentSummary;
  onClose: () => void;
}) {
  const code = useDeploymentCode(agent, deployment.id);
  return (
    <Dialog title={`${version(deployment.version)} source`} wide onClose={onClose}>
      {code.isError ? (
        <LoadError
          things="the source"
          error={code.error}
          compact
          onRetry={() => void code.refetch()}
        />
      ) : code.data === undefined ? (
        <div className="skeleton" role="status" aria-label="Loading the source">
          <span className="skeleton__line" />
          <span className="skeleton__line" />
          <span className="skeleton__line" />
        </div>
      ) : (
        <div className="json deployment-source">
          <pre className="json__code" dir="ltr">
            {code.data.code}
          </pre>
          <CopyButton value={code.data.code} what="the source" />
        </div>
      )}
    </Dialog>
  );
}

/** `PATCH /v1/agents/:agent` with a version: new actors start on it, and followers move to it. */
function Activate({
  agent,
  deployment,
  active,
  onClose,
}: {
  agent: string;
  deployment: DeploymentSummary;
  active: number;
  onClose: () => void;
}) {
  const activate = useMutation({
    mutationFn: () => engine.activate(agent, deployment.version),
    onSuccess: () => {
      // The agent, the list of agents and its actors all say which version is theirs.
      void queryClient.invalidateQueries();
      onClose();
    },
  });
  const to = version(deployment.version);
  return (
    <Confirm
      title={`Make ${to} active?`}
      sentence={`New actors start on ${to}, in place of ${version(active)}. Actors that follow the active version move to ${to} at the start of their next turn; actors pinned to a version stay on it.`}
      action="Make active"
      pending={activate.isPending}
      error={activate.error === null ? null : errorText(activate.error)}
      onConfirm={() => activate.mutate()}
      onClose={onClose}
    />
  );
}
