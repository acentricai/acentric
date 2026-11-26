// An agent: its header, actors, deployments and secrets.

import type {
  Actor,
  CreateActorRequest,
  DeploymentSummary,
  Json,
  Reasoning,
  Secret,
} from '@acentric/protocol';
import { IconChevronDown, IconChevronRight, IconPlus } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { Outlet, useLocation, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState } from 'react';

import { NOTHING, shortId, version } from '../../format.ts';
import { useMachines } from '../../machines/queries.ts';
import { may, useMe, type Me } from '../../me.ts';
import {
  Ago,
  Button,
  Command,
  Confirm,
  Dialog,
  Field,
  FormError,
  Label,
  Menu,
  MenuItem,
  Pager,
  PageTabs,
  Status,
  errorText,
  type Column,
} from '../../ui.tsx';
import { curl, engine, inputTypes, isApiError, queryClient } from '../api.ts';
import { ActorLink, AgentLink, actorPath, agentPath } from '../links.tsx';
import {
  keys,
  pageCursors,
  useActors,
  useAgent,
  useAgents,
  useDeployment,
  useDeployments,
  useSecrets,
} from '../queries.ts';
import { STATUSES, type ActorsSearch, type DeploymentsSearch } from '../url.ts';
import { AgentLoadError, AgentTable } from './agents.tsx';
import '../agents.css';

function useAgentParams() {
  return useParams({ strict: false }) as { agent: string };
}

const holds = (me: Me | undefined, permission: Parameters<typeof may>[1]) =>
  me !== undefined && may(me, permission);

export function AgentLayout() {
  const { agent } = useAgentParams();
  const pathname = useLocation({ select: (location) => location.pathname });
  const me = useMe();
  const detail = useAgent(agent);
  const missing = isApiError(detail.error, 404);
  const latest = useDeployment(agent, detail.data?.latestDeployment.id);
  const definition = latest.data?.definition;

  return (
    <div className="agent-page">
      <header className="agent-head page__head--spaced rise">
        <div className="agent-head__main">
          <div className="agent-head__title">
            <h1 className="page__title">{detail.data?.name ?? agent}</h1>
          </div>
          {detail.data !== undefined && definition !== undefined ? (
            <div className="agent-head__facts">
              <span className="mono">{version(detail.data.latestDeployment.version)}</span>
              <span className="mono">{definition.provider}</span>
              <span className="chips">
                {inputTypes(definition).map((type) => (
                  <Label key={type}>{type}</Label>
                ))}
              </span>
            </div>
          ) : detail.isPending || latest.isPending ? (
            <div className="agent-head__loading" role="status" aria-label="Loading the agent">
              <span className="skeleton__line" />
              <span className="skeleton__line" />
            </div>
          ) : null}
        </div>
      </header>
      {detail.isError && (
        <AgentLoadError
          error={detail.error}
          title="Agent"
          compact
          onRetry={() => void detail.refetch()}
        />
      )}
      {!missing && (
        <>
          <PageTabs
            label={detail.data?.name ?? agent}
            tabs={[
              {
                name: 'Actors',
                link: {
                  to: agentPath(agent),
                  activeOptions: { exact: true, includeSearch: false },
                },
              },
              {
                name: 'Deployments',
                link: {
                  to: agentPath(agent, 'deployments'),
                  activeOptions: { includeSearch: false },
                },
              },
              ...(holds(me.data, 'secrets:write')
                ? [{ name: 'Secrets', link: { to: agentPath(agent, 'secrets') } }]
                : []),
            ]}
          />
          <div className="agent-section" key={`${agent}/${pathname}`}>
            <Outlet />
          </div>
        </>
      )}
    </div>
  );
}

// Actors

/** How an actor's last turn ended, in a word or two. */
export function lastTurnWord(lastTurn: Actor['lastTurn']): string | null {
  if (lastTurn === null) return null;
  if (lastTurn.end === 'ok') return 'ended';
  return lastTurn.reason === undefined ? lastTurn.end : `${lastTurn.end} · ${lastTurn.reason}`;
}

/** What an actor is called: its name, or its ID while it has none. */
export const actorName = (
  actor: { readonly id: string; readonly name: string | null },
  max = 28,
): string => actor.name ?? shortId(actor.id, max);

/** The names of the machines, for a person who may list them. */
function useMachineNames(enabled: boolean): ReadonlyMap<string, string> {
  const machines = useMachines(enabled);
  return new Map((machines.data?.items ?? []).map((one) => [one.id as string, one.name]));
}

export function ActorsTab() {
  const { agent } = useAgentParams();
  const me = useMe();
  const search = useSearch({ strict: false }) as ActorsSearch;
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const actors = useActors(agent, search.status, search.cursor);
  const pages = pageCursors(search.cursor, actors.data?.nextCursor);
  const rows = actors.data?.items;
  const filtered = search.status !== undefined;
  const machineNames = useMachineNames(holds(me.data, 'machines:manage'));
  const to = (more: ActorsSearch) =>
    void navigate({ to: agentPath(agent), search: { ...search, ...more } as never });

  const columns: Column<Actor>[] = [
    {
      name: 'Actor',
      cell: (actor) => (
        <div className="ac-table__primary">
          <ActorLink
            actor={actor.id}
            className="agent-actor-link"
            title={actor.name === null && actor.id.length <= 28 ? undefined : actor.id}
          >
            <span className="ac-id agent-actor-id">
              <span className="ac-id__text">{actorName(actor)}</span>
            </span>
          </ActorLink>
          {actor.parent !== null && <span className="note">subagent {actor.parent.name}</span>}
        </div>
      ),
    },
    { name: 'Status', cell: (actor) => <Status word={actor.status} /> },
    {
      name: 'Last turn',
      cell: (actor) => {
        const word = lastTurnWord(actor.lastTurn);
        return word === null ? (
          <span className="ac-table__muted">{NOTHING}</span>
        ) : (
          <Status word={word} />
        );
      },
    },
    {
      name: 'Version',
      cell: (actor) => <span className="mono">{version(actor.deployment.version)}</span>,
    },
    { name: 'Model', cell: (actor) => <span className="mono agent-model">{actor.modelId}</span> },
    {
      name: 'Machine',
      cell: (actor) =>
        actor.machine === null ? (
          <span className="ac-table__muted">{NOTHING}</span>
        ) : (
          <span className="mono" title={actor.machine.id}>
            {machineNames.get(actor.machine.id) ?? actor.machine.id}
          </span>
        ),
    },
    {
      name: 'Waiting',
      cell: (actor) =>
        actor.pendingInputs > 0 ? (
          <span className="ac-num note--warn">{actor.pendingInputs}</span>
        ) : null,
      className: 'ac-table__num',
    },
    {
      name: 'Created',
      className: 'ac-table__muted',
      cell: (actor) => <Ago at={actor.createdAt} />,
    },
  ];

  return (
    <div>
      <div className="section-bar">
        <div className="filter-bar">
          <Filter
            name="Status"
            value={search.status}
            options={STATUSES}
            onChange={(status) => to({ status, cursor: undefined })}
          />
        </div>
        {holds(me.data, 'actors:write') && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            <IconPlus size={16} stroke={1.75} aria-hidden="true" />
            New actor
          </Button>
        )}
      </div>
      {actors.isError && (
        <AgentLoadError error={actors.error} title="Actors" onRetry={() => void actors.refetch()} />
      )}
      {!(actors.isError && rows === undefined) && (
        <div className="rise">
          <AgentTable
            label="Actors"
            className="sessions-table"
            columns={columns}
            rows={rows}
            rowKey={(actor) => actor.id}
            loading={actors.isPending}
            empty={
              <>
                <span>No actors</span>
                {!filtered && search.cursor === undefined && (
                  <Command
                    text={curl('POST', `/v1/agents/${encodeURIComponent(agent)}/actors`, {})}
                  />
                )}
              </>
            }
            onRow={(actor) => void navigate({ to: actorPath(actor.id) })}
          />
          <Pager
            newer={pages.newer === null ? null : () => to({ cursor: pages.newer || undefined })}
            older={
              pages.older === null
                ? null
                : () => {
                    const older = pages.older ?? '';
                    pages.remember(older);
                    to({ cursor: older });
                  }
            }
          />
        </div>
      )}
      {creating && <NewActor agent={agent} onClose={() => setCreating(false)} />}
    </div>
  );
}

/** Selecting the current filter again clears it. */
function Filter<T extends string>({
  name,
  value,
  options,
  onChange,
}: {
  name: string;
  value: T | undefined;
  options: readonly T[];
  onChange: (value: T | undefined) => void;
}) {
  return (
    <Menu
      label={value === undefined ? name : `${name}: ${value}`}
      button={
        <>
          <span className="dropdown__value">
            {value === undefined ? name : `${name}: ${value}`}
          </span>
          <IconChevronDown size={14} stroke={1.75} aria-hidden="true" />
        </>
      }
    >
      {(close) =>
        options.map((option) => (
          <MenuItem
            key={option}
            checked={value === option}
            onSelect={() => {
              close();
              onChange(value === option ? undefined : option);
            }}
          >
            <Status word={option} />
          </MenuItem>
        ))
      }
    </Menu>
  );
}

/** Give the native shared dialog an exit matching its entrance, before unmounting. */
export function useDialogMotion(onClose: () => void) {
  const [closing, setClosing] = useState(false);
  const leaving = useRef(false);
  const afterClose = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(() => {
      onClose();
      afterClose.current?.();
    }, 180);
    return () => clearTimeout(timer);
  }, [closing, onClose]);
  return {
    closing,
    close: (after?: () => void) => {
      if (leaving.current) return;
      leaving.current = true;
      afterClose.current = after;
      if (
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ) {
        onClose();
        after?.();
      } else setClosing(true);
    },
  };
}

/** `NAME=value` a line, blank lines and `#` comments left out. */
export function parseEnv(text: string): {
  env: { [name: string]: string };
  error: string | null;
} {
  const env: { [name: string]: string } = {};
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at <= 0) return { env, error: `Line ${String(index + 1)} is not NAME=value` };
    env[line.slice(0, at).trim()] = line.slice(at + 1);
  }
  return { env, error: null };
}

function NewActor({ agent, onClose }: { agent: string; onClose: () => void }) {
  const navigate = useNavigate();
  const me = useMe();
  const detail = useAgent(agent);
  // A new actor is made on the agent's active deployment: what that says decides the fields.
  const active = useDeployment(agent, detail.data?.activeDeployment.id);
  // Only a person who manages machines may list them: any other names one.
  const listsMachines = holds(me.data, 'machines:manage');
  const machines = useMachines(listsMachines);
  const motion = useDialogMotion(onClose);
  const formId = useId();
  const [name, setName] = useState('');
  const [modelId, setModelId] = useState('');
  const [reasoning, setReasoning] = useState('');
  const [machine, setMachine] = useState('');
  const [cwd, setCwd] = useState('');
  const [env, setEnv] = useState('');
  const [configuration, setConfiguration] = useState('{}');
  const [localError, setLocalError] = useState<{
    field: 'configuration' | 'env';
    text: string;
  } | null>(null);
  const definition = active.data?.definition;
  const takesConfiguration = definition !== undefined && definition.configuration !== null;
  // Its agent says whether its actors work on a machine: all of them do, or none.
  const machineRule = definition?.features?.includes('machine') === true;
  const create = useMutation({
    mutationFn: (body: CreateActorRequest) => engine.createActor(agent, body),
    onSuccess: ({ actor }) => {
      void queryClient.invalidateQueries({ queryKey: ['actors', agent] });
      motion.close(() => {
        void navigate({ to: actorPath(actor.id) });
      });
    },
  });
  const fieldError = (code: string) =>
    create.isError && isApiError(create.error) && create.error.code === code
      ? create.error.message
      : null;
  const nameError = fieldError('name_taken');
  const configurationError =
    (localError?.field === 'configuration' ? localError.text : null) ??
    fieldError('invalid_configuration');
  const envError = localError?.field === 'env' ? localError.text : null;
  const otherError =
    create.isError && nameError === null && configurationError === null
      ? errorText(create.error)
      : null;

  return (
    <div className="agent-dialog" data-closing={motion.closing || undefined}>
      <Dialog
        title="New actor"
        onClose={() => motion.close()}
        footer={
          <>
            <Button onClick={() => motion.close()}>Cancel</Button>
            <Button variant="primary" type="submit" form={formId} busy={create.isPending}>
              New actor
            </Button>
          </>
        }
      >
        <form
          id={formId}
          className="dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (create.isPending || motion.closing) return;
            let parsed: Json | undefined;
            if (takesConfiguration) {
              try {
                parsed = JSON.parse(configuration) as Json;
              } catch (error) {
                setLocalError({ field: 'configuration', text: errorText(error) });
                return;
              }
            }
            const variables = parseEnv(env);
            if (variables.error !== null) {
              setLocalError({ field: 'env', text: variables.error });
              return;
            }
            setLocalError(null);
            create.mutate({
              ...(name.trim() === '' ? {} : { name: name.trim() }),
              ...(modelId.trim() === '' ? {} : { modelId: modelId.trim() }),
              ...(reasoning.trim() === '' ? {} : { reasoning: reasoning.trim() as Reasoning }),
              ...(machine.trim() === ''
                ? {}
                : {
                    machine: {
                      id: machine.trim() as never,
                      cwd: cwd.trim() === '' ? '~' : cwd.trim(),
                      ...(Object.keys(variables.env).length === 0 ? {} : { env: variables.env }),
                    },
                  }),
              ...(parsed === undefined ? {} : { configuration: parsed }),
            });
          }}
        >
          <Field label="Name" optional error={nameError}>
            {(inputId) => (
              <input
                id={inputId}
                className="ac-input ac-input--md ac-input--mono"
                value={name}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={nameError !== null || undefined}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
          <Field label="Model" optional hint="The provider's default when left empty.">
            {(inputId) => (
              <input
                id={inputId}
                className="ac-input ac-input--md ac-input--mono"
                value={modelId}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setModelId(event.target.value)}
              />
            )}
          </Field>
          <Field label="Reasoning" optional>
            {(inputId) => (
              <input
                id={inputId}
                className="ac-input ac-input--md ac-input--mono"
                value={reasoning}
                spellCheck={false}
                autoComplete="off"
                placeholder="low, medium, high…"
                onChange={(event) => setReasoning(event.target.value)}
              />
            )}
          </Field>
          {machineRule && (
            <Field label="Machine">
              {(inputId) =>
                listsMachines ? (
                  <select
                    id={inputId}
                    className="ac-input ac-input--md"
                    value={machine}
                    required
                    onChange={(event) => setMachine(event.target.value)}
                  >
                    <option value="" disabled>
                      Choose a machine
                    </option>
                    {(machines.data?.items ?? [])
                      .filter((each) => each.agents === '*' || each.agents.includes(agent as never))
                      .map((each) => (
                        <option key={each.id} value={each.id}>
                          {each.name}
                          {each.online ? '' : ' (offline)'}
                        </option>
                      ))}
                  </select>
                ) : (
                  <input
                    id={inputId}
                    className="ac-input ac-input--md ac-input--mono"
                    value={machine}
                    spellCheck={false}
                    autoComplete="off"
                    required
                    onChange={(event) => setMachine(event.target.value)}
                  />
                )
              }
            </Field>
          )}
          {machineRule && machine.trim() !== '' && (
            <>
              <Field label="Working directory" hint="Its home directory when left empty.">
                {(inputId) => (
                  <input
                    id={inputId}
                    className="ac-input ac-input--md ac-input--mono"
                    value={cwd}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="~/work"
                    onChange={(event) => setCwd(event.target.value)}
                  />
                )}
              </Field>
              <Field
                label="Environment"
                optional
                hint="NAME=value a line, for its commands. Kept sealed; only the names are shown again."
                error={envError}
              >
                {(inputId) => (
                  <textarea
                    id={inputId}
                    className="ac-input ac-input--mono"
                    rows={3}
                    spellCheck={false}
                    value={env}
                    aria-invalid={envError !== null || undefined}
                    onChange={(event) => setEnv(event.target.value)}
                  />
                )}
              </Field>
            </>
          )}
          {takesConfiguration && (
            <Field label="Configuration" error={configurationError}>
              {(inputId) => (
                <textarea
                  id={inputId}
                  className="ac-input ac-input--mono"
                  rows={6}
                  spellCheck={false}
                  value={configuration}
                  aria-invalid={configurationError !== null || undefined}
                  onChange={(event) => setConfiguration(event.target.value)}
                />
              )}
            </Field>
          )}
          <FormError error={otherError} />
        </form>
      </Dialog>
    </div>
  );
}

// Deployments

export function DeploymentsTab() {
  const { agent } = useAgentParams();
  const search = useSearch({ strict: false }) as DeploymentsSearch;
  const navigate = useNavigate();
  const detail = useAgent(agent);
  const deployments = useDeployments(agent);
  const rows = deployments.data?.items;
  const newest = rows?.[0]?.version;
  const active = detail.data?.activeDeployment.version;
  const toggle = (deployment: DeploymentSummary) =>
    void navigate({
      to: agentPath(agent, 'deployments'),
      search: { v: search.v === deployment.version ? undefined : deployment.version } as never,
      replace: true,
    });

  const columns: Column<DeploymentSummary>[] = [
    {
      name: 'Version',
      cell: (deployment) => (
        <div className="agent-version">
          <button
            type="button"
            className="agent-version__button"
            aria-expanded={search.v === deployment.version}
            onClick={() => toggle(deployment)}
          >
            <IconChevronRight size={16} stroke={1.75} aria-hidden="true" />
            <span className="mono">{version(deployment.version)}</span>
          </button>
          {deployment.version === newest && <Label>latest</Label>}
          {deployment.version === active && active !== newest && <Label>active</Label>}
        </div>
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
  ];

  return (
    <div className="section-grid">
      {deployments.isError && (
        <AgentLoadError
          error={deployments.error}
          title="Deployments"
          onRetry={() => void deployments.refetch()}
        />
      )}
      {!(deployments.isError && rows === undefined) && (
        <div className="rise">
          <AgentTable
            label="Deployments"
            className="agent-deployments"
            columns={columns}
            rows={rows}
            rowKey={(deployment) => deployment.id}
            loading={deployments.isPending}
            empty="No deployments"
            onRow={toggle}
            expanded={(deployment) => deployment.version === search.v}
            detail={(deployment) => <Declares agent={agent} deployment={deployment.id} />}
          />
        </div>
      )}
    </div>
  );
}

/** What a version said of itself when it was deployed: data, descriptions included. */
export function Declares({ agent, deployment }: { agent: string; deployment: string }) {
  const detail = useDeployment(agent, deployment);
  // A subagent is named by its agent's name: its page is found by that.
  const agents = useAgents();
  if (detail.isError) {
    return (
      <AgentLoadError
        error={detail.error}
        title="Deployment"
        compact
        onRetry={() => void detail.refetch()}
      />
    );
  }
  if (detail.data === undefined) {
    return (
      <div
        className="agent-declares"
        role="status"
        aria-label="Loading deployment"
        aria-busy="true"
      >
        <div className="skeleton">
          <span className="skeleton__line" />
          <span className="skeleton__line" />
          <span className="skeleton__line" />
          <span className="skeleton__line" />
        </div>
      </div>
    );
  }
  const declares = detail.data.definition;
  const nothing = <span className="ac-table__muted">{NOTHING}</span>;
  const settings = declares.compactionSettings ?? {};
  const compaction = Object.keys(settings).length === 0 ? null : settings;
  const mcps = declares.mcps ?? [];
  const subagents = declares.subagents ?? [];
  const idOf = (name: string) => agents.data?.items.find((one) => one.name === name)?.id;
  return (
    <dl className="facts agent-declares">
      <div>
        <dt>provider</dt>
        <dd className="mono">{declares.provider}</dd>
      </div>
      <div>
        <dt>tools</dt>
        <dd>
          {declares.tools.length === 0 ? (
            nothing
          ) : (
            <ul className="agent-declarations">
              {declares.tools.map((tool) => (
                <li key={tool.name}>
                  <span className="mono">{tool.name}</span>
                  {tool.codemode === true && <Label>code mode</Label>}
                  {!tool.retrySafe && <Label>not retry safe</Label>}
                  {tool.description !== '' && (
                    <span className="ac-table__muted"> {tool.description}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </dd>
      </div>
      <div>
        <dt>inputs</dt>
        <dd className="chips">
          {declares.inputs.length === 0
            ? nothing
            : declares.inputs.map((input) => <Label key={input.type}>{input.type}</Label>)}
        </dd>
      </div>
      <div>
        <dt>configuration</dt>
        <dd className="mono">{declares.configuration === null ? 'none' : 'yes'}</dd>
      </div>
      <div>
        <dt>mcp servers</dt>
        <dd>
          {mcps.length === 0 ? (
            nothing
          ) : (
            <ul className="agent-declarations">
              {mcps.map((mcp) => (
                <li key={mcp.name}>
                  <span className="mono">{mcp.name}</span>
                  <span className="ac-table__muted mono"> {mcp.url}</span>
                  {mcp.description !== undefined && (
                    <span className="ac-table__muted"> {mcp.description}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </dd>
      </div>
      <div>
        <dt>subagents</dt>
        <dd>
          {subagents.length === 0 ? (
            nothing
          ) : (
            <ul className="agent-declarations">
              {subagents.map((subagent) => {
                const id = idOf(subagent.agent);
                return (
                  <li key={subagent.agent}>
                    {id === undefined ? (
                      <span className="mono">{subagent.agent}</span>
                    ) : (
                      <AgentLink agent={id} className="mono">
                        {subagent.agent}
                      </AgentLink>
                    )}
                    <span className="ac-table__muted"> {subagent.description}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </dd>
      </div>
      <div>
        <dt>compaction</dt>
        <dd>
          {compaction === null ? (
            nothing
          ) : (
            <span className="mono">{JSON.stringify(compaction)}</span>
          )}
        </dd>
      </div>
      <div>
        <dt>instructions</dt>
        <dd>
          {declares.instructions === '' ? (
            nothing
          ) : (
            <pre className="prose-text">{declares.instructions}</pre>
          )}
        </dd>
      </div>
    </dl>
  );
}

// Secrets

export function SecretsTab() {
  const { agent } = useAgentParams();
  const secrets = useSecrets(agent);
  const [setting, setSetting] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const rows = secrets.data?.items;

  const columns: Column<Secret>[] = [
    { name: 'Name', cell: (secret) => <code className="secret-name">{secret.name}</code> },
    {
      name: '',
      className: 'ac-table__num',
      cell: (secret) => (
        <div className="row-actions">
          <Button size="sm" variant="quiet" onClick={() => setRemoving(secret.name)}>
            Remove
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="secrets">
      <div className="section-bar section-bar--end">
        <Button onClick={() => setSetting(true)}>Set secret</Button>
      </div>
      {secrets.isError && (
        <AgentLoadError
          error={secrets.error}
          title="Secrets"
          onRetry={() => void secrets.refetch()}
        />
      )}
      {!(secrets.isError && rows === undefined) && (
        <AgentTable
          label="Secrets"
          columns={columns}
          rows={rows}
          rowKey={(secret) => secret.name}
          loading={secrets.isPending}
          empty="No secrets"
        />
      )}
      {setting && (
        <SetSecret
          agent={agent}
          existing={new Set((rows ?? []).map((secret) => secret.name))}
          onClose={() => setSetting(false)}
        />
      )}
      {removing !== null && (
        <RemoveSecret agent={agent} name={removing} onClose={() => setRemoving(null)} />
      )}
    </div>
  );
}

function RemoveSecret({
  agent,
  name,
  onClose,
}: {
  agent: string;
  name: string;
  onClose: () => void;
}) {
  const motion = useDialogMotion(onClose);
  const remove = useMutation({
    mutationFn: () => engine.removeSecret(agent, name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.secrets(agent) });
      motion.close();
    },
  });
  return (
    <div className="agent-dialog" data-closing={motion.closing || undefined}>
      <Confirm
        title="Remove"
        sentence={name}
        action="Remove"
        danger
        pending={remove.isPending}
        error={remove.isError ? errorText(remove.error) : null}
        onConfirm={() => {
          if (!motion.closing) remove.mutate();
        }}
        onClose={() => motion.close()}
      />
    </div>
  );
}

function SetSecret({
  agent,
  existing,
  onClose,
}: {
  agent: string;
  existing: ReadonlySet<string>;
  onClose: () => void;
}) {
  const motion = useDialogMotion(onClose);
  const formId = useId();
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [confirming, setConfirming] = useState(false);
  const set = useMutation({
    mutationFn: () => engine.setSecret(agent, name.trim(), value),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.secrets(agent) });
      motion.close();
    },
  });
  if (confirming) {
    return (
      <div className="agent-dialog" data-closing={motion.closing || undefined}>
        <Confirm
          title="Replace secret"
          sentence={name.trim()}
          action="Set secret"
          pending={set.isPending}
          error={set.isError ? errorText(set.error) : null}
          onConfirm={() => {
            if (!motion.closing) set.mutate();
          }}
          onClose={() => motion.close()}
        />
      </div>
    );
  }
  return (
    <div className="agent-dialog" data-closing={motion.closing || undefined}>
      <Dialog
        title="Set secret"
        onClose={() => motion.close()}
        footer={
          <>
            <Button onClick={() => motion.close()}>Cancel</Button>
            <Button variant="primary" type="submit" form={formId} busy={set.isPending}>
              Set secret
            </Button>
          </>
        }
      >
        <form
          id={formId}
          className="dialog-form"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            if (set.isPending || motion.closing || name.trim() === '' || value === '') return;
            if (existing.has(name.trim())) setConfirming(true);
            else set.mutate();
          }}
        >
          <Field label="Name">
            {(inputId) => (
              <input
                id={inputId}
                className="ac-input ac-input--md ac-input--mono"
                required
                spellCheck={false}
                autoComplete="off"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
          <Field label="Value">
            {(inputId) => (
              <input
                id={inputId}
                type="password"
                className="ac-input ac-input--md ac-input--mono"
                required
                autoComplete="new-password"
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            )}
          </Field>
          <FormError error={set.error} />
        </form>
      </Dialog>
    </div>
  );
}
