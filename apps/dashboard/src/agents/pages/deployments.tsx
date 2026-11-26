// An agent's deployments, newest first: which is active, each opened by its version or its menu
// (what it declared, and its code), and from its menu making it the active one.

import type { DeploymentSummary } from '@acentric/protocol';
import { IconCircleCheck, IconCode } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useState } from 'react';

import { version } from '../../format.ts';
import {
  Ago,
  Confirm,
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
import { useAgent, useDeployments } from '../queries.ts';
import type { DeploymentsSearch } from '../url.ts';
import { DEPLOYMENT_TABS, DeploymentDialog, type DeploymentTab } from './deployment.tsx';
import '../../machines/machine-pane.css';
import '../agents.css';

type Action = { kind: 'activate'; deployment: DeploymentSummary };

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
  const tab = DEPLOYMENT_TABS.find((one) => one.id === search.tab)?.id ?? 'instructions';
  // The open one, and its tab, are in the address: they can be linked to and survive a reload.
  const show = (v: number | undefined, to?: DeploymentTab) =>
    void navigate({
      to: agentPath(agent, 'deployments'),
      search: { v, tab: to === 'instructions' ? undefined : to } as never,
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
                          show(deployment.version);
                        }}
                      >
                        View source
                      </MenuItem>
                      {deploys && (
                        <MenuItem
                          disabled={active === undefined || deployment.version === active}
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
        <DeploymentDialog
          key={opened.id}
          agent={agent}
          deployment={opened}
          tab={tab}
          onTab={(to) => show(opened.version, to)}
          onClose={() => show(undefined)}
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
