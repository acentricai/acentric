// An agent's deployments, newest first: which is active, and what each declared when it was
// deployed, opened by its version.

import type { DeploymentSummary } from '@acentric/protocol';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';

import { version } from '../../format.ts';
import { Ago, Dialog, LoadError, PageHeader, Table } from '../../machines/ui.tsx';
import { Label } from '../../ui.tsx';
import { agentPath } from '../links.tsx';
import { useAgent, useDeployments } from '../queries.ts';
import type { DeploymentsSearch } from '../url.ts';
import { Declares } from './agent.tsx';
import '../../machines/machine-pane.css';
import '../agents.css';

export function DeploymentsPage() {
  const { agent } = useParams({ strict: false }) as { agent: string };
  const search = useSearch({ strict: false }) as DeploymentsSearch;
  const navigate = useNavigate();
  const detail = useAgent(agent);
  const deployments = useDeployments(agent);
  const rows = deployments.data?.items;
  const active = detail.data?.activeDeployment.version;
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
    </div>
  );
}
