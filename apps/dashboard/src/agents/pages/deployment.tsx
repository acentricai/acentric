// A deployment, opened: what its code declared when it was deployed, a tab for each part, and
// the code itself, as it was deployed, in the last.

import type { AgentDefinition, DeploymentSummary } from '@acentric/protocol';
import {
  IconAdjustmentsHorizontal,
  IconArrowsMinimize,
  IconCode,
  IconFileText,
  IconInbox,
  IconKey,
  IconPlug,
  IconSitemap,
  IconTool,
} from '@tabler/icons-react';
import type { ReactNode } from 'react';

import { Code, JsonCode } from '../../code.tsx';
import { version } from '../../format.ts';
import { LoadError } from '../../machines/ui.tsx';
import { displayText } from '../../machines/text.tsx';
import { SideDialog, type SideTab } from '../../side-dialog.tsx';
import { Label } from '../../ui.tsx';
import { AgentLink } from '../links.tsx';
import { useAgents, useDeployment, useDeploymentCode } from '../queries.ts';

export const DEPLOYMENT_TABS = [
  { id: 'instructions', name: 'Instructions', icon: IconFileText },
  { id: 'tools', name: 'Tools', icon: IconTool },
  { id: 'inputs', name: 'Inputs', icon: IconInbox },
  { id: 'configuration', name: 'Configuration', icon: IconAdjustmentsHorizontal },
  { id: 'mcp', name: 'MCP servers', icon: IconPlug },
  { id: 'subagents', name: 'Subagents', icon: IconSitemap },
  { id: 'secrets', name: 'Secrets', icon: IconKey },
  { id: 'compaction', name: 'Compaction', icon: IconArrowsMinimize },
  { id: 'raw', name: 'Raw', icon: IconCode },
] as const satisfies readonly SideTab[];

export type DeploymentTab = (typeof DEPLOYMENT_TABS)[number]['id'];

export function DeploymentDialog({
  agent,
  deployment,
  tab,
  onTab,
  onClose,
}: {
  agent: string;
  deployment: DeploymentSummary;
  tab: DeploymentTab;
  onTab: (tab: DeploymentTab) => void;
  onClose: () => void;
}) {
  const detail = useDeployment(agent, deployment.id);
  const name = DEPLOYMENT_TABS.find((one) => one.id === tab)?.name ?? '';
  const definition = detail.data?.definition;
  return (
    <SideDialog
      title={version(deployment.version)}
      label={`${version(deployment.version)}'s parts`}
      tabs={DEPLOYMENT_TABS}
      chosen={tab}
      onChoose={(id) => onTab(id as DeploymentTab)}
      onClose={onClose}
    >
      <div className="prefs-page deployment-page">
        <h3 className="prefs-group__title">{name}</h3>
        {tab === 'raw' ? (
          <Raw agent={agent} deployment={deployment.id} />
        ) : detail.isError ? (
          <LoadError
            things="the deployment"
            error={detail.error}
            compact
            onRetry={() => void detail.refetch()}
          />
        ) : definition === undefined ? (
          <Loading what="the deployment" />
        ) : (
          <Part tab={tab} definition={definition} />
        )}
      </div>
    </SideDialog>
  );
}

function Loading({ what }: { what: string }) {
  return (
    <div className="skeleton" role="status" aria-label={`Loading ${what}`}>
      <span className="skeleton__line" />
      <span className="skeleton__line" />
      <span className="skeleton__line" />
    </div>
  );
}

const None = ({ children }: { children: ReactNode }) => <p className="note">{children}</p>;

/** One thing a part declares: its name and marks, what it is for, and its schema. */
function Item({
  name,
  marks,
  text,
  children,
}: {
  name: ReactNode;
  marks?: ReactNode;
  text?: string | undefined;
  children?: ReactNode;
}) {
  return (
    <li className="decl">
      <div className="decl__head">
        <span className="decl__name mono">{name}</span>
        {marks}
      </div>
      {text !== undefined && text !== '' && <p className="decl__text">{displayText(text)}</p>}
      {children}
    </li>
  );
}

function Part({ tab, definition }: { tab: DeploymentTab; definition: AgentDefinition }) {
  switch (tab) {
    case 'instructions':
      return definition.instructions === '' ? (
        <None>
          {definition.features?.includes('actor-instructions') === true
            ? 'Its code makes each actor’s own.'
            : 'None'}
        </None>
      ) : (
        <div className="decl-prose">
          <pre className="prose-text">{displayText(definition.instructions, true)}</pre>
        </div>
      );
    case 'tools':
      return definition.tools.length === 0 ? (
        <None>No tools</None>
      ) : (
        <ul className="decl-list">
          {definition.tools.map((tool) => (
            <Item
              key={tool.name}
              name={displayText(tool.name)}
              text={tool.description}
              marks={
                <>
                  {tool.codemode === true && <Label>code mode</Label>}
                  {!tool.retrySafe && <Label>not retry safe</Label>}
                </>
              }
            >
              <JsonCode value={tool.parameters} what={`${tool.name}'s parameters`} />
            </Item>
          ))}
        </ul>
      );
    case 'inputs':
      return definition.inputs.length === 0 ? (
        <None>No inputs</None>
      ) : (
        <ul className="decl-list">
          {definition.inputs.map((input) => (
            <Item key={input.type} name={displayText(input.type)}>
              {input.schema === null ? (
                <None>Its schema can’t be shown.</None>
              ) : (
                <JsonCode value={input.schema} what={`${input.type}'s schema`} />
              )}
            </Item>
          ))}
        </ul>
      );
    case 'configuration':
      return definition.configuration === null ? (
        <None>Its actors take no configuration.</None>
      ) : definition.configuration.schema === null ? (
        <None>Its schema can’t be shown.</None>
      ) : (
        <JsonCode value={definition.configuration.schema} what="the configuration's schema" />
      );
    case 'mcp': {
      const mcps = definition.mcps ?? [];
      return mcps.length === 0 ? (
        <None>No MCP servers</None>
      ) : (
        <ul className="decl-list">
          {mcps.map((mcp) => (
            <Item key={mcp.name} name={displayText(mcp.name)} text={mcp.description}>
              <span className="mono decl__text">{displayText(mcp.url)}</span>
            </Item>
          ))}
        </ul>
      );
    }
    case 'subagents':
      return <Subagents definition={definition} />;
    case 'secrets': {
      const secrets = definition.secrets ?? [];
      return secrets.length === 0 ? (
        <None>No secrets</None>
      ) : (
        <ul className="decl-list">
          {secrets.map((secret) => (
            <Item key={secret} name={secret} />
          ))}
        </ul>
      );
    }
    case 'compaction': {
      const settings = definition.compactionSettings ?? {};
      return Object.keys(settings).length === 0 ? (
        <None>The engine’s own</None>
      ) : (
        <JsonCode value={settings} what="the compaction settings" />
      );
    }
    case 'raw':
      return null;
  }
}

function Subagents({ definition }: { definition: AgentDefinition }) {
  // A subagent is named by its agent's name: its page is found by that.
  const agents = useAgents();
  const subagents = definition.subagents ?? [];
  if (subagents.length === 0) return <None>No subagents</None>;
  return (
    <ul className="decl-list">
      {subagents.map((subagent) => {
        const id = agents.data?.items.find((one) => one.name === subagent.agent)?.id;
        return (
          <Item
            key={subagent.agent}
            name={
              id === undefined ? (
                displayText(subagent.agent)
              ) : (
                <AgentLink agent={id}>{displayText(subagent.agent)}</AgentLink>
              )
            }
            text={subagent.description}
          >
            {subagent.schema !== undefined && (
              <JsonCode value={subagent.schema} what={`${subagent.agent}'s schema`} />
            )}
          </Item>
        );
      })}
    </ul>
  );
}

/** The code, as it was deployed: one module, the SDK it was built with first. */
function Raw({ agent, deployment }: { agent: string; deployment: string }) {
  const code = useDeploymentCode(agent, deployment);
  if (code.isError) {
    return (
      <LoadError
        things="the source"
        error={code.error}
        compact
        onRetry={() => void code.refetch()}
      />
    );
  }
  if (code.data === undefined) return <Loading what="the source" />;
  return <Code text={code.data.code} language="javascript" what="the source" />;
}
