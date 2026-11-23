// One actor: its header (where it stands and its facts, Interrupt and Abort, the menu), what it
// has going on (tasks, subagents, its mailbox), its conversation with each turn a band, and the
// composer that sends it an input. Drawn as the reference dashboard draws a session
// (agents/actor.css).

import type { Actor, Input, Json, SendInputResponse, Task } from '@acentric/protocol';
import {
  IconArchive,
  IconArrowDown,
  IconBraces,
  IconChevronRight,
  IconLink,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
  IconSettings,
  IconStack2,
  IconTerminal2,
  IconVariable,
} from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import {
  clockMs,
  duration,
  fullTime,
  NOTHING,
  plural,
  started,
  tokens,
  version as v,
} from '../../format.ts';
import { useMachines } from '../../machines/queries.ts';
import { may as holds, useMe, type Me } from '../../me.ts';
import { typing } from '../../shell/keyboard.ts';
import {
  Ago,
  Button,
  copyText,
  CopyId,
  Dialog,
  Field,
  FormError,
  Label,
  LoadError,
  Menu,
  MenuItem,
  Notice,
  Skeleton,
  Status,
  Table,
  errorText,
  useNow,
  type Column,
} from '../../ui.tsx';
import { curl, engine, inputTypes, isApiError, queryClient } from '../api.ts';
import { ActorLink, AgentLink } from '../links.tsx';
import { bandEnding, type Band, type LogItem, type Row } from '../log/model.ts';
import type { Standing } from '../log/stream.ts';
import { useActorLog } from '../log/use-log.ts';
import { copyJson, JsonView, RecordView } from '../log/view.tsx';
import {
  keys,
  useActor,
  useActorUsage,
  useAgent,
  useAgents,
  useDeployment,
  useDeployments,
  useInputs,
  useSubagents,
  useTask,
  useTasks,
} from '../queries.ts';
import { seqFromHash, seqHash } from '../url.ts';
import { lastTurnWord, parseEnv } from './agent.tsx';
import '../actor.css';

type DialogKind = 'abort' | 'archive' | 'change' | 'env' | 'configuration' | null;

type Permission = Parameters<typeof holds>[1];

const allowed = (me: Me | undefined, permission: Permission) =>
  me !== undefined && holds(me, permission);

/** Dollars: `$1,234.56`, `$0.42`, and to four places under a cent, `$0.0042`; `$0.00` for none. */
export function dollars(value: number): string {
  if (value === 0) return '$0.00';
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function ActorPage() {
  const { actor: id } = useParams({ strict: false }) as { actor: string };
  const me = useMe();
  const actor = useActor(id);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const may = (permission: Permission) => allowed(me.data, permission);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: keys.actor(id) });
    void queryClient.invalidateQueries({ queryKey: ['actors'] });
  };
  const act = useMutation({
    mutationFn: async (
      how: 'interrupt' | 'abort' | 'retry' | 'compact' | 'archive' | 'unarchive',
    ) => {
      await engine[how](id);
      return how;
    },
    onSuccess: (how) => {
      refresh();
      setDialog(null);
      const words: Record<string, string> = {
        interrupt: 'Its turn was ended. Its tasks and subagents go on.',
        abort: 'Its turn, its tasks and its subagents were stopped.',
        retry: 'It takes its turn again.',
        compact: 'Its conversation was compacted.',
        archive: 'It was archived: it takes no input.',
        unarchive: 'It was taken out of the archive.',
      };
      setNotice(words[how] ?? null);
    },
    onError: (error) => setNotice(errorText(error)),
  });
  const closeDialog = () => {
    act.reset();
    setDialog(null);
  };

  const missing = isApiError(actor.error, 404);
  const info = missing ? undefined : actor.data;
  const agent = useAgent(info?.agent ?? '');
  const archived = info?.status === 'archived';
  const busy = info?.status === 'working';

  return (
    <div className="agent-page session-page">
      <header className="agent-head rise">
        <div className="agent-head__main">
          <div className="agent-head__title">
            <h1 className="page__title">
              {info === undefined ? (
                id
              ) : (
                <AgentLink agent={info.agent} className="title-link">
                  {agent.data?.name ?? info.agent}
                </AgentLink>
              )}
            </h1>
            <CopyId value={id} max={28} label="actor ID" />
          </div>
          {!missing && (
            <p className="agent-head__facts">
              {info === undefined ? (
                actor.isError ? null : (
                  <span className="skeleton__line agent-head__skeleton" aria-hidden="true" />
                )
              ) : (
                <HeadFacts info={info} />
              )}
            </p>
          )}
        </div>
        {!missing && info !== undefined && (
          <div className="page__actions">
            {info.status === 'working' && may('actors:stop') && (
              <Button
                busy={act.isPending && act.variables === 'interrupt'}
                onClick={() => act.mutate('interrupt')}
              >
                <IconPlayerPause size={15} stroke={1.75} aria-hidden="true" />
                Interrupt
              </Button>
            )}
            {busy && may('actors:stop') && (
              <Button onClick={() => setDialog('abort')}>
                <IconPlayerStop size={15} stroke={1.75} aria-hidden="true" />
                Abort
              </Button>
            )}
            <Menu label="More actions" align="end" variant="more">
              {(close) => (
                <>
                  {info.lastTurn?.end === 'failed' &&
                    info.status !== 'working' &&
                    may('actors:stop') && (
                      <MenuItem
                        icon={<IconRefresh size={16} stroke={1.75} aria-hidden="true" />}
                        onSelect={() => {
                          close();
                          act.mutate('retry');
                        }}
                      >
                        Retry the turn
                      </MenuItem>
                    )}
                  {may('actors:write') && !archived && (
                    <>
                      <MenuItem
                        icon={<IconStack2 size={16} stroke={1.75} aria-hidden="true" />}
                        disabled={info.status === 'working'}
                        onSelect={() => {
                          close();
                          act.mutate('compact');
                        }}
                      >
                        Compact
                      </MenuItem>
                      <MenuItem
                        icon={<IconSettings size={16} stroke={1.75} aria-hidden="true" />}
                        onSelect={() => {
                          close();
                          setDialog('change');
                        }}
                      >
                        Change
                      </MenuItem>
                      {info.machine !== null && (
                        <MenuItem
                          icon={<IconVariable size={16} stroke={1.75} aria-hidden="true" />}
                          onSelect={() => {
                            close();
                            setDialog('env');
                          }}
                        >
                          Environment
                        </MenuItem>
                      )}
                    </>
                  )}
                  <MenuItem
                    icon={<IconBraces size={16} stroke={1.75} aria-hidden="true" />}
                    onSelect={() => {
                      close();
                      setDialog('configuration');
                    }}
                  >
                    Configuration
                  </MenuItem>
                  {may('actors:write') && (
                    <MenuItem
                      icon={<IconArchive size={16} stroke={1.75} aria-hidden="true" />}
                      danger={!archived}
                      onSelect={() => {
                        close();
                        if (archived) act.mutate('unarchive');
                        else setDialog('archive');
                      }}
                    >
                      {archived ? 'Unarchive' : 'Archive'}
                    </MenuItem>
                  )}
                </>
              )}
            </Menu>
          </div>
        )}
      </header>
      {notice !== null && <Notice title={notice} />}
      {actor.isError && (
        <LoadError error={actor.error} things="the actor" onRetry={() => void actor.refetch()} />
      )}
      {info !== undefined && <Going info={info} />}
      {/* Mounted afresh for each actor: one actor's reads never reach another's log. */}
      {!missing && <Log key={id} id={id} info={info} canSend={may('actors:send')} />}
      {dialog === 'abort' && (
        <StopDialog
          title="Abort"
          sentence="Stop its turn, its tasks and its subagents?"
          action="Abort"
          busy="Aborting…"
          pending={act.isPending}
          error={act.isError ? errorText(act.error) : null}
          onConfirm={() => act.mutate('abort')}
          onClose={closeDialog}
        />
      )}
      {dialog === 'archive' && (
        <StopDialog
          title="Archive"
          sentence={`Archive ${info?.name ?? id}? It is aborted and takes no more input until it is unarchived. Its conversation is kept.`}
          action="Archive"
          busy="Archiving…"
          danger
          pending={act.isPending}
          error={act.isError ? errorText(act.error) : null}
          onConfirm={() => act.mutate('archive')}
          onClose={closeDialog}
        />
      )}
      {dialog === 'change' && info !== undefined && (
        <ChangeDialog info={info} onClose={() => setDialog(null)} />
      )}
      {dialog === 'env' && info !== undefined && (
        <EnvDialog info={info} onClose={() => setDialog(null)} />
      )}
      {dialog === 'configuration' && info !== undefined && (
        <Dialog
          title="Configuration"
          onClose={() => setDialog(null)}
          wide
          footer={
            <Button variant="primary" onClick={() => setDialog(null)} data-autofocus>
              Done
            </Button>
          }
        >
          <JsonView value={info.configuration} label="configuration" />
        </Dialog>
      )}
    </div>
  );
}

/**
 * The header's facts, `·` between them: name, status, version, model, machine, last turn,
 * waiting, created.
 */
function HeadFacts({ info }: { info: Actor }) {
  const me = useMe();
  const last = lastTurnWord(info.lastTurn);
  const machines = useMachines(allowed(me.data, 'machines:manage'));
  const machineName =
    info.machine === null
      ? undefined
      : machines.data?.items.find((one) => one.id === info.machine?.id)?.name;
  return (
    <>
      {info.name !== null && <span className="mono">{info.name}</span>}
      {/* Keyed by the status, so a change draws in place. */}
      <span className="session-status" key={info.status}>
        <Status word={info.status} />
      </span>
      <span className="mono">{v(info.deployment.version)}</span>
      <span className="mono">{info.modelId}</span>
      <span className="mono">{info.reasoning}</span>
      {info.machine !== null && (
        <span className="mono" title={info.machine.cwd}>
          {machineName ?? info.machine.id}
        </span>
      )}
      {info.parent !== null && (
        <span>
          subagent {info.parent.name} of{' '}
          <ActorLink actor={info.parent.id} className="mono title-link">
            {info.parent.id}
          </ActorLink>
        </span>
      )}
      {info.status !== 'working' && last !== null && (
        <span className="session-status" key={`last-${last}`}>
          <Status word={last} />
        </span>
      )}
      {info.pendingInputs > 0 && <span>{info.pendingInputs} waiting</span>}
      <Spent id={info.id} />
      <span>
        <Ago at={info.createdAt} prefix="created " />
      </span>
    </>
  );
}

/** What its model calls cost: its own, and with its subagents' when they spent too. */
function Spent({ id }: { id: string }) {
  const me = useMe();
  const usage = useActorUsage(id, allowed(me.data, 'usage:read'));
  if (usage.data === undefined || usage.data.tree.calls === 0) return null;
  const { own, tree } = usage.data;
  return (
    <span title={`${String(tree.calls)} model calls`}>
      {dollars(own.cost)} spent
      {tree.cost > own.cost ? ` · ${dollars(tree.cost)} with subagents` : ''}
    </span>
  );
}

/** Interrupt, Abort and Archive: the sentence, `Cancel`, and the action. */
function StopDialog({
  title,
  sentence,
  action,
  busy,
  danger = false,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  title: string;
  sentence: string;
  action: string;
  busy: string;
  danger?: boolean;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} data-autofocus>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} busy={pending} onClick={onConfirm}>
            {pending ? busy : action}
          </Button>
        </>
      }
    >
      <p className="ac-dialog__body">{sentence}</p>
      {error !== null && (
        <p className="ac-field__error form-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}

/** `PATCH /v1/actors/:actor`, between its turns: its version, model and reasoning. */
function ChangeDialog({ info, onClose }: { info: Actor; onClose: () => void }) {
  const deployments = useDeployments(info.agent);
  const formId = useId();
  // One that is not pinned follows the agent's active deployment.
  const now = info.pinned ? String(info.deployment.version) : 'active';
  const [version, setVersion] = useState(now);
  const [modelId, setModelId] = useState(info.modelId);
  const [reasoning, setReasoning] = useState<string>(info.reasoning);
  const change = useMutation({
    mutationFn: () =>
      engine.updateActor(info.id, {
        ...(version === now ? {} : { version: version === 'active' ? 'active' : Number(version) }),
        ...(modelId.trim() === info.modelId ? {} : { modelId: modelId.trim() }),
        ...(reasoning.trim() === info.reasoning
          ? {}
          : { reasoning: reasoning.trim() as Actor['reasoning'] }),
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData(keys.actor(info.id), updated);
      void queryClient.invalidateQueries({ queryKey: ['actors'] });
      onClose();
    },
  });
  const unchanged =
    version === now && modelId.trim() === info.modelId && reasoning.trim() === info.reasoning;
  return (
    <Dialog
      title="Change"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            busy={change.isPending}
            disabled={unchanged}
          >
            Save
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!unchanged && !change.isPending) change.mutate();
        }}
      >
        <Field label="Version">
          {(inputId) => (
            <select
              id={inputId}
              className="ac-input ac-input--md"
              value={version}
              onChange={(event) => setVersion(event.target.value)}
            >
              <option value="active">Active</option>
              {(deployments.data?.items ?? []).map((deployment) => (
                <option key={deployment.id} value={deployment.version}>
                  {v(deployment.version)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Model">
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
        <Field label="Reasoning">
          {(inputId) => (
            <input
              id={inputId}
              className="ac-input ac-input--md ac-input--mono"
              value={reasoning}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setReasoning(event.target.value)}
            />
          )}
        </Field>
        <p className="note">Changed between its turns: one going on now ends first.</p>
        <FormError error={change.error} />
      </form>
    </Dialog>
  );
}

/** `PATCH /v1/actors/:actor { env }`: every variable its commands are run with, in place of what it had. */
function EnvDialog({ info, onClose }: { info: Actor; onClose: () => void }) {
  const formId = useId();
  const names = info.machine?.env ?? [];
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (env: { [name: string]: string }) => engine.updateActor(info.id, { env }),
    onSuccess: (updated) => {
      queryClient.setQueryData(keys.actor(info.id), updated);
      onClose();
    },
  });
  return (
    <Dialog
      title="Environment"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form={formId} busy={save.isPending}>
            Replace
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = parseEnv(text);
          if (parsed.error !== null) {
            setError(parsed.error);
            return;
          }
          setError(null);
          save.mutate(parsed.env);
        }}
      >
        <div className="ac-field">
          <span className="ac-field__label">Now</span>
          {names.length === 0 ? (
            <span className="note">None</span>
          ) : (
            <span className="chips">
              {names.map((name) => (
                <span key={name} className="chip chip--mono">
                  {name}
                </span>
              ))}
            </span>
          )}
        </div>
        <Field
          label="Variables"
          hint="NAME=value a line. They replace all it has; values are never shown again."
          error={error}
        >
          {(inputId) => (
            <textarea
              id={inputId}
              className="ac-input ac-input--mono"
              rows={5}
              spellCheck={false}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          )}
        </Field>
        <FormError error={save.error} />
      </form>
    </Dialog>
  );
}

// What it has going on

const TASK_WORDS: Record<Task['status'], string> = {
  running: 'running',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
  lost: 'lost',
};

/** Its tasks, the actors it spawned, and what waits in its mailbox: each shown when it has some. */
function Going({ info }: { info: Actor }) {
  const me = useMe();
  const tasks = useTasks(info.id);
  const subagents = useSubagents(info.id);
  const inputs = useInputs(info.id);
  const agents = useAgents();
  const [opened, setOpened] = useState<string | null>(null);
  const stop = useMutation({
    mutationFn: (task: string) => engine.stopTask(info.id, task),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.tasks(info.id) });
      void queryClient.invalidateQueries({ queryKey: keys.actor(info.id) });
    },
  });
  // The tasks are read again whenever where the actor stands changes.
  const standing = `${info.status}/${String(info.pendingInputs)}/${String(info.lastTurn?.at)}`;
  const refetchTasks = tasks.refetch;
  useEffect(() => {
    void refetchTasks();
  }, [standing, refetchTasks]);
  const agentName = (agent: string) =>
    agents.data?.items.find((one) => one.id === agent)?.name ?? agent;

  const taskColumns: Column<Task>[] = [
    {
      name: 'Task',
      cell: (task) => (
        <button type="button" className="title-link mono" onClick={() => setOpened(task.id)}>
          {task.id}
        </button>
      ),
    },
    { name: 'Kind', cell: (task) => <span className="mono">{task.kind}</span> },
    {
      name: 'Status',
      cell: (task) => (
        <Status
          word={
            task.stoppedBy === undefined
              ? TASK_WORDS[task.status]
              : `${task.status} · ${task.stoppedBy}`
          }
        />
      ),
    },
    { name: 'Started', className: 'ac-table__muted', cell: (task) => <Ago at={task.startedAt} /> },
    {
      name: 'Took',
      className: 'ac-table__muted',
      cell: (task) =>
        task.endedAt === undefined ? NOTHING : duration(task.endedAt - task.startedAt),
    },
    {
      name: '',
      className: 'ac-table__num',
      cell: (task) =>
        task.status === 'running' && allowed(me.data, 'actors:stop') ? (
          <Button
            size="sm"
            variant="quiet"
            busy={stop.isPending && stop.variables === task.id}
            onClick={() => stop.mutate(task.id)}
          >
            Stop
          </Button>
        ) : null,
    },
  ];
  const subagentColumns: Column<Actor>[] = [
    {
      name: 'Name',
      cell: (actor) => <span className="mono">{actor.parent?.name ?? NOTHING}</span>,
    },
    {
      name: 'Actor',
      cell: (actor) => (
        <ActorLink actor={actor.id} className="agent-actor-link mono">
          {actor.id}
        </ActorLink>
      ),
    },
    { name: 'Agent', cell: (actor) => <span className="mono">{agentName(actor.agent)}</span> },
    { name: 'Status', cell: (actor) => <Status word={actor.status} /> },
    {
      name: 'Created',
      className: 'ac-table__muted',
      cell: (actor) => <Ago at={actor.createdAt} />,
    },
  ];
  const taskRows = tasks.data?.items ?? [];
  const subagentRows = subagents.data?.items ?? [];
  const waiting = inputs.data?.items ?? [];
  if (taskRows.length === 0 && subagentRows.length === 0 && waiting.length === 0) return null;
  return (
    <div className="session-going rise">
      {taskRows.length > 0 && (
        <section aria-label="Tasks">
          <h2 className="panel__title">Tasks</h2>
          <Table
            label="Tasks"
            loading={false}
            columns={taskColumns}
            rows={taskRows}
            rowKey={(task) => task.id}
          />
          <FormError error={stop.error} />
        </section>
      )}
      {subagentRows.length > 0 && (
        <section aria-label="Subagents">
          <h2 className="panel__title">Subagents</h2>
          <Table
            label="Subagents"
            loading={false}
            columns={subagentColumns}
            rows={subagentRows}
            rowKey={(actor) => actor.id}
          />
        </section>
      )}
      {waiting.length > 0 && (
        <section aria-label="Mailbox">
          <h2 className="panel__title">Waiting</h2>
          <Table<Input>
            label="Mailbox"
            loading={false}
            columns={[
              { name: 'Input', cell: (input) => <span className="mono">{input.type}</span> },
              {
                name: 'ID',
                cell: (input) => <span className="mono ac-table__muted">{input.id}</span>,
              },
              {
                name: '',
                cell: (input) => (input.quiet === true ? <Label>with the next turn</Label> : null),
              },
              {
                name: 'Received',
                className: 'ac-table__muted',
                cell: (input) => <Ago at={input.receivedAt} />,
              },
            ]}
            rows={waiting}
            rowKey={(input) => input.id}
          />
        </section>
      )}
      {opened !== null && (
        <TaskDialog actor={info.id} task={opened} onClose={() => setOpened(null)} />
      )}
    </div>
  );
}

/** One task: what it was started with, and its result once it has one. */
function TaskDialog({
  actor,
  task,
  onClose,
}: {
  actor: string;
  task: string;
  onClose: () => void;
}) {
  const detail = useTask(actor, task);
  return (
    <Dialog
      title={task}
      onClose={onClose}
      wide
      footer={
        <Button variant="primary" onClick={onClose} data-autofocus>
          Done
        </Button>
      }
    >
      {detail.isPending ? (
        <Skeleton rows={4} label="Loading the task" />
      ) : detail.isError ? (
        <FormError error={detail.error} />
      ) : (
        <div className="log__detail">
          <div className="log__section">
            <p className="log__label">input</p>
            <div className="log__section-body">
              <JsonView value={detail.data.input} label="input" />
            </div>
          </div>
          <div className="log__section">
            <p className="log__label">result</p>
            <div className="log__section-body">
              {detail.data.result === null ? (
                <span className="note">
                  {detail.data.status === 'running' ? 'Still running' : NOTHING}
                </span>
              ) : (
                <pre className="prose-text mono">{detail.data.result}</pre>
              )}
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}

// The log

function Log({ id, info, canSend }: { id: string; info: Actor | undefined; canSend: boolean }) {
  const [following, setFollowing] = useState(() => seqFromHash(location.hash) === null);
  const followingRef = useRef(following);
  useEffect(() => {
    followingRef.current = following;
  }, [following]);
  const [fresh, setFresh] = useState(0);
  const [arrived, setArrived] = useState(0);
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(new Set());
  const [marked, setMarked] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [goTo, setGoTo] = useState<number | null>(() => seqFromHash(location.hash));

  const onMessages = useCallback(() => {
    if (!followingRef.current) setFresh((n) => n + 1);
    setArrived((n) => n + 1);
  }, []);
  // The header follows the stream: where the actor stands is in it.
  const onStanding = useCallback(
    (standing: Standing) => {
      queryClient.setQueryData<Actor>(keys.actor(id), (was) =>
        was === undefined ? was : { ...was, ...standing },
      );
      void queryClient.invalidateQueries({ queryKey: keys.actor(id) });
      void queryClient.invalidateQueries({ queryKey: keys.inputs(id) });
      void queryClient.invalidateQueries({ queryKey: keys.subagents(id) });
    },
    [id],
  );
  const log = useActorLog(id, { onMessages, onStanding });

  const follow = () => {
    setFollowing(true);
    setFresh(0);
    window.scrollTo({ top: document.documentElement.scrollHeight });
  };

  // Following: at the bottom the view keeps to new rows.
  useLayoutEffect(() => {
    if (!following || !log.ready) return;
    window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [arrived, following, log.ready]);

  useEffect(() => {
    const scrolled = () => {
      const bottom =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 48;
      if (bottom && !followingRef.current) {
        setFollowing(true);
        setFresh(0);
      } else if (!bottom && followingRef.current) {
        setFollowing(false);
      }
    };
    window.addEventListener('scroll', scrolled, { passive: true });
    return () => window.removeEventListener('scroll', scrolled);
  }, []);

  // `#seq-4803`: the band that holds it opens, with the row open and marked.
  useEffect(() => {
    const changed = () => {
      const seq = seqFromHash(location.hash);
      if (seq !== null) setGoTo(seq);
    };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  const reveal = log.reveal;
  useEffect(() => {
    if (goTo === null || !log.ready) return;
    setFollowing(false);
    const key = seqHash(goTo);
    reveal(goTo);
    setOpenRows((was) => new Set(was).add(key));
    setMarked(key);
  }, [goTo, log.ready, reveal]);
  useEffect(() => {
    if (goTo === null) return;
    const element = document.getElementById(seqHash(goTo));
    if (element === null) return;
    element.scrollIntoView({ block: 'start' });
    element.querySelector<HTMLElement>('.log__row')?.focus({ preventScroll: true });
    setGoTo(null);
  }, [goTo, log.items, log.open]);

  const toggleRow = useCallback((key: string) => {
    setOpenRows((was) => {
      const now = new Set(was);
      if (now.has(key)) now.delete(key);
      else now.add(key);
      return now;
    });
  }, []);

  // Keyboard: j k between rows, [ ] between turns, f follows.
  const visible = useMemo(() => flatten(log.items, log.open), [log.items, log.open]);
  const followRef = useRef(follow);
  useEffect(() => {
    followRef.current = follow;
  });
  useEffect(() => {
    const press = (event: KeyboardEvent) => {
      if (typing(event)) return;
      const at = focusKey === null ? -1 : visible.findIndex((entry) => entry.key === focusKey);
      const focus = (key: string | undefined) => {
        if (key === undefined) return;
        setFocusKey(key);
        const element = document.querySelector<HTMLElement>(`[data-key="${key}"]`);
        element?.focus();
        element?.scrollIntoView({ block: 'nearest' });
      };
      if (event.key === 'j' || event.key === 'k') {
        event.preventDefault();
        const rows = visible.filter((entry) => entry.kind === 'row');
        const index = rows.findIndex((entry) => entry.key === focusKey);
        const next = event.key === 'j' ? index + 1 : index === -1 ? rows.length - 1 : index - 1;
        focus(rows[Math.max(0, Math.min(rows.length - 1, next))]?.key);
        if (event.key === 'k') setFollowing(false);
      } else if (event.key === '[' || event.key === ']') {
        event.preventDefault();
        const bands = visible.filter((entry) => entry.kind === 'band');
        const current = visible
          .slice(0, at + 1)
          .toReversed()
          .find((entry) => entry.kind === 'band');
        const index = current === undefined ? -1 : bands.indexOf(current);
        const next =
          event.key === ']'
            ? index + 1
            : index <= 0
              ? 0
              : current?.key === focusKey
                ? index - 1
                : index;
        focus(bands[Math.max(0, Math.min(bands.length - 1, next))]?.key);
        setFollowing(false);
      } else if (event.key === 'f') {
        event.preventDefault();
        followRef.current();
      }
    };
    window.addEventListener('keydown', press);
    return () => window.removeEventListener('keydown', press);
  }, [visible, focusKey]);

  const archived = info?.status === 'archived';
  const lastBand = log.items.findLast((item): item is Band => item.type === 'band');
  const now = useNow();
  const stream = log.stream === 'idle' ? 'reconnecting' : log.stream;
  const live = log.ready && stream !== 'ended';

  return (
    <>
      <section className="logs rise" aria-label="Conversation" aria-busy={!log.ready}>
        <div className="logs__bar">
          <span className="note">
            {plural(log.items.filter((item) => item.type === 'band').length, 'turn')}
          </span>
          <span className="logs__end">
            {log.ready && (
              <span className="logs__stream session-status" key={stream} role="status">
                <Status
                  word={stream}
                  tone={
                    stream === 'live' ? 'running' : stream === 'reconnecting' ? 'waiting' : 'closed'
                  }
                  tiny
                />
              </span>
            )}
            {live && (
              <Button
                variant={following ? 'secondary' : 'quiet'}
                className="follow"
                aria-pressed={following}
                onClick={() => (following ? setFollowing(false) : follow())}
              >
                {following ? (
                  <>
                    <span className="glow-dot" aria-hidden="true" />
                    Following
                    <IconPlayerPause size={14} stroke={1.75} aria-hidden="true" />
                  </>
                ) : (
                  <>
                    <IconPlayerPlay size={14} stroke={1.75} aria-hidden="true" />
                    {fresh > 0 ? `Follow · ${String(fresh)} new` : 'Follow'}
                  </>
                )}
              </Button>
            )}
          </span>
        </div>
        <div className="logs__box log-box">
          {log.error !== null && log.error !== undefined && (
            <div className="log-error">
              <LoadError
                error={log.error}
                things="the conversation"
                onRetry={() => location.reload()}
                compact
              />
            </div>
          )}
          {!log.ready && (log.error === null || log.error === undefined) && (
            <div className="log-loading">
              <Skeleton rows={8} label="Loading the conversation" />
            </div>
          )}
          {log.ready && log.items.length === 0 && <p className="logs__empty">No messages</p>}
          {log.items.map((item) => (
            <ItemView
              key={item.key}
              item={item}
              open={item.type === 'band' && log.open.has(item.turn)}
              last={item.type === 'band' && item.turn === lastBand?.turn}
              now={now}
              onToggleBand={log.toggle}
              openRows={openRows}
              onToggleRow={toggleRow}
              marked={marked}
              onFocusRow={setFocusKey}
              id={id}
            />
          ))}
        </div>
      </section>
      {!following && fresh > 0 && (
        <Button className="new-rows" onClick={follow}>
          {fresh} new
          <IconArrowDown size={14} stroke={1.75} aria-hidden="true" />
        </Button>
      )}
      {info !== undefined && !archived && canSend && (
        <SendBar
          info={info}
          onSent={() => {
            setFollowing(true);
            setFresh(0);
          }}
        />
      )}
    </>
  );
}

type Focusable = { key: string; kind: 'band' | 'row' };

function flatten(items: readonly LogItem[], open: ReadonlySet<number>): Focusable[] {
  const out: Focusable[] = [];
  for (const item of items) {
    if (item.type === 'rule') {
      out.push({ key: item.key, kind: 'row' });
      continue;
    }
    out.push({ key: item.key, kind: 'band' });
    if (open.has(item.turn)) for (const row of item.rows) out.push({ key: row.key, kind: 'row' });
  }
  return out;
}

type ItemProps = {
  item: LogItem;
  open: boolean;
  last: boolean;
  now: number;
  onToggleBand: (turn: number) => void;
  openRows: ReadonlySet<string>;
  onToggleRow: (key: string) => void;
  marked: string | null;
  onFocusRow: (key: string) => void;
  id: string;
};

function ItemView(props: ItemProps) {
  const { item } = props;
  if (item.type === 'rule') {
    return (
      <ol className="session-log session-log--rule">
        <RowView row={item.row} {...props} />
      </ol>
    );
  }
  return <BandView band={item} {...props} />;
}

/** Model calls and tokens for a band's line: left out when zero. */
export function bandCounts(band: Pick<Band, 'calls' | 'tokensIn' | 'tokensOut'>): string[] {
  const out: string[] = [];
  if (band.calls > 0) out.push(plural(band.calls, 'model call'));
  if (band.tokensIn > 0 || band.tokensOut > 0) out.push(tokens(band.tokensIn, band.tokensOut));
  return out;
}

/** The band's status as the design's statuses have it. */
const BAND_STATUS: Record<Band['status'], string> = {
  running: 'running',
  ended: 'completed',
  ok: 'completed',
  failed: 'failed',
  interrupted: 'aborted',
  refused: 'failed',
};

function BandView({
  band,
  open,
  now,
  onToggleBand,
  onFocusRow,
  ...rest
}: ItemProps & { band: Band }) {
  const ending = bandEnding(band);
  const took = band.endedAt === null ? null : duration(band.endedAt - band.startedAt);
  const counts = bandCounts(band);
  return (
    <section
      className="band"
      data-status={BAND_STATUS[band.status]}
      aria-label={`Turn ${String(band.turn)}`}
    >
      <button
        type="button"
        className="band__line"
        aria-expanded={open}
        data-key={band.key}
        onFocus={() => onFocusRow(band.key)}
        onClick={() => onToggleBand(band.turn)}
      >
        <IconChevronRight className="band__chevron" size={14} stroke={1.75} aria-hidden="true" />
        <span className="band__name">Turn {band.turn}</span>
        <span className="band__facts">
          {/* Keyed by how it ended, so the end draws in place. */}
          <span className="session-status" key={ending}>
            <Status word={ending} tiny />
          </span>
          <span title={fullTime(band.startedAt)}>{started(band.startedAt, now)}</span>
          {took !== null && <span>{took}</span>}
          {counts.map((part) => (
            <span key={part}>{part}</span>
          ))}
        </span>
      </button>
      {open && (
        <ol className="session-log">
          {windows(band.rows).map((rows, index, all) => (
            <RowWindow
              key={rows[0]?.key ?? index}
              rows={rows}
              last={index === all.length - 1}
              keep={rows.some((row) => row.key === rest.marked || rest.openRows.has(row.key))}
            >
              {rows.map((row) => (
                <RowView
                  key={row.key}
                  row={row}
                  onFocusRow={onFocusRow}
                  {...rest}
                  open={open}
                  now={now}
                  onToggleBand={onToggleBand}
                  item={band}
                />
              ))}
            </RowWindow>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Rows drawn together: a long band is drawn a window at a time, as it scrolls into view. */
export const WINDOW = 100;

export function windows<T>(rows: readonly T[], size = WINDOW): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < rows.length; at += size) out.push(rows.slice(at, at + size));
  return out;
}

/**
 * A window of rows: drawn once it comes near the screen, and kept drawn. Until then it holds
 * its place with as many empty rows of the same height. The last window, where the tail is, and
 * one holding an open or marked row are drawn at once.
 */
function RowWindow({
  rows,
  last,
  keep,
  children,
}: {
  rows: readonly Row[];
  last: boolean;
  keep: boolean;
  children: ReactNode;
}) {
  const place = useRef<HTMLLIElement>(null);
  const [seen, setSeen] = useState(
    () => last || keep || typeof IntersectionObserver === 'undefined',
  );
  useEffect(() => {
    if (seen || last || keep) return;
    const element = place.current;
    if (element === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
      },
      { rootMargin: '800px 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [seen, last, keep]);
  if (seen || last || keep) return <>{children}</>;
  return (
    <li ref={place} className="log__window" aria-hidden="true">
      {rows.map((row) => (
        <span key={row.key} className="log__space" />
      ))}
    </li>
  );
}

function RowView({ row, openRows, onToggleRow, marked, onFocusRow, id }: ItemProps & { row: Row }) {
  const open = openRows.has(row.key);
  const classes = [
    'log__item',
    'stream-in',
    `log__item--${row.tone}`,
    row.rule ? 'log__item--rule' : '',
    row.depth === 1 ? 'log__item--nested' : '',
  ]
    .filter((part) => part !== '')
    .join(' ');
  const seq = row.seq;
  return (
    <li
      className={classes}
      id={seq === null ? undefined : seqHash(seq)}
      data-open={open || undefined}
      data-marked={marked === row.key || undefined}
    >
      <div className="log__head">
        <button
          type="button"
          className="log__row"
          aria-expanded={open}
          data-key={row.key}
          onFocus={() => onFocusRow(row.key)}
          onClick={() => onToggleRow(row.key)}
        >
          <span className="log__seq">{seq ?? ''}</span>
          {row.at === null ? (
            <span className="log__time">·</span>
          ) : (
            <time
              className="log__time"
              dateTime={new Date(row.at).toISOString()}
              title={fullTime(row.at)}
            >
              {clockMs(row.at)}
            </time>
          )}
          <span className="log__kind">{row.kind}</span>
          <span className="log__body">
            <span className="log__summary">{row.summary}</span>
            {row.tags.map((tag) => (
              <span key={tag} className="log__tag">
                {tag}
              </span>
            ))}
          </span>
          <span className="log__measure">{row.measure}</span>
          <IconChevronRight className="log__chevron" size={14} stroke={1.75} aria-hidden="true" />
        </button>
        {row.message !== null && seq !== null ? (
          <Menu label={`Message ${String(seq)}`} align="end" variant="more" className="row-menu">
            {(close) => (
              <>
                <MenuItem
                  icon={<IconBraces size={16} stroke={1.75} aria-hidden="true" />}
                  onSelect={() => {
                    close();
                    void copyText(copyJson(row.message));
                  }}
                >
                  Copy JSON
                </MenuItem>
                <MenuItem
                  icon={<IconLink size={16} stroke={1.75} aria-hidden="true" />}
                  onSelect={() => {
                    close();
                    const url = new URL(location.href);
                    url.hash = seqHash(seq);
                    void copyText(url.toString());
                  }}
                >
                  Copy link
                </MenuItem>
                <MenuItem
                  icon={<IconTerminal2 size={16} stroke={1.75} aria-hidden="true" />}
                  onSelect={() => {
                    close();
                    void copyText(
                      curl(
                        'GET',
                        `/v1/actors/${encodeURIComponent(id)}/messages?after=${String(seq - 1)}&limit=1`,
                      ),
                    );
                  }}
                >
                  Copy curl
                </MenuItem>
              </>
            )}
          </Menu>
        ) : (
          <span className="row-menu-space" />
        )}
      </div>
      {open && <RecordView row={row} actor={id} />}
    </li>
  );
}

// Sending an input

function newInputId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return `in_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function SendBar({
  info,
  onSent,
}: {
  info: Actor;
  onSent: (answer: SendInputResponse) => void;
}) {
  const detail = useDeployment(info.agent, info.deployment.id);
  const inputs = detail.data === undefined ? [] : inputTypes(detail.data.definition);
  const [type, setType] = useState('');
  const [payload, setPayload] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<SendInputResponse['status'] | null>(null);
  // Made before sending: one that could not be confirmed goes again as the same input.
  const inputId = useRef(newInputId());
  const ids = { type: useId(), payload: useId() };
  const chosen = type === '' ? (inputs[0] ?? '') : type;

  // What is typed now, read by answers that come back after it changed.
  const draft = useRef({ type: chosen, payload });
  useEffect(() => {
    draft.current = { type: chosen, payload };
  });
  // Set at once, before React re-renders: a second Enter while one send is out is ignored.
  const sending = useRef(false);

  const send = useMutation({
    mutationFn: (sent: { id: string; type: string; payload: Json; text: string }) =>
      engine.send(info.id, { type: sent.type, payload: sent.payload, externalId: sent.id }),
    onSuccess: (result, sent) => {
      setAnswer(result.status);
      // An answer clears only the draft it was sent with; an edited one stays as typed.
      if (draft.current.payload === sent.text && draft.current.type === sent.type) {
        setPayload('');
        inputId.current = newInputId();
      }
      void queryClient.invalidateQueries({ queryKey: keys.actor(info.id) });
      void queryClient.invalidateQueries({ queryKey: keys.inputs(info.id) });
      onSent(result);
    },
    onSettled: () => {
      sending.current = false;
    },
  });

  /** The one way an input is sent, by the button and by Ctrl or Cmd and Enter. */
  const submit = () => {
    if (sending.current || chosen === '') return;
    let parsed: Json;
    try {
      parsed = JSON.parse(payload === '' ? '{}' : payload) as Json;
    } catch (error) {
      setJsonError(errorText(error));
      return;
    }
    sending.current = true;
    setJsonError(null);
    setAnswer(null);
    send.mutate({ id: inputId.current, type: chosen, payload: parsed, text: payload });
  };
  const fieldError =
    jsonError ??
    (send.isError &&
    isApiError(send.error) &&
    ['invalid_input', 'unknown_input'].includes(send.error.code)
      ? send.error.message
      : null);
  const otherError = send.isError && fieldError === null ? errorText(send.error) : null;

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="composer__row">
        <span className="select composer__type">
          <select
            id={ids.type}
            className="ac-input ac-input--md ac-input--mono"
            aria-label="Input type"
            value={chosen}
            onChange={(event) => {
              setType(event.target.value);
              inputId.current = newInputId();
            }}
          >
            {inputs.map((input) => (
              <option key={input} value={input}>
                {input}
              </option>
            ))}
          </select>
        </span>
        <textarea
          id={ids.payload}
          className="ac-input ac-input--mono json-editor composer__payload"
          aria-label="Payload"
          rows={1}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          placeholder='{ "text": "…" }'
          value={payload}
          aria-invalid={fieldError !== null}
          onChange={(event) => {
            setPayload(event.target.value);
            setJsonError(null);
            inputId.current = newInputId();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <Button
          type="submit"
          variant="primary"
          busy={send.isPending}
          disabled={chosen === ''}
          className="composer__send"
        >
          Send
        </Button>
      </div>
      {(fieldError !== null || otherError !== null || answer !== null) && (
        <div className="composer__status" role="status">
          {fieldError !== null && <p className="ac-field__error">{fieldError}</p>}
          {otherError !== null && <p className="ac-field__error">{otherError}</p>}
          {answer !== null && fieldError === null && otherError === null && (
            <span className="session-status" key={answer}>
              <Status
                word={answer === 'duplicate' ? 'sent before' : 'sent'}
                tone={answer === 'duplicate' ? 'plain' : 'running'}
                tiny
              />
            </span>
          )}
        </div>
      )}
    </form>
  );
}
