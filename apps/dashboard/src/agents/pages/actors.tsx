// An agent's actors, newest first: a page at a time, each opened by its name,
// archived, unarchived or deleted from its menu, and a new one made with the model account it
// is to be called with.

import { REASONING_LEVELS } from '@acentric/protocol';
import type { Actor, CreateActorRequest, Json, Reasoning } from '@acentric/protocol';
import { IconArchive, IconArchiveOff, IconPlus, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useId, useState } from 'react';

import { NOTHING, version } from '../../format.ts';
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
  errorText,
} from '../../machines/ui.tsx';
import { useMachines } from '../../machines/queries.ts';
import { may, useMe, type Me } from '../../me.ts';
import { Dropdown, Pager, Status } from '../../ui.tsx';
import { engine, queryClient } from '../api.ts';
import { ActorLink, actorPath, agentPath } from '../links.tsx';
import { pageCursors, useActors, useAgent, useDeployment } from '../queries.ts';
import type { ActorsSearch } from '../url.ts';
import { actorName, lastTurnWord, parseEnv } from './agent.tsx';
import '../../machines/machine-pane.css';
import '../agents.css';

const holds = (me: Me | undefined, permission: Parameters<typeof may>[1]) =>
  me !== undefined && may(me, permission);

/** The model accounts, for one who may list them: none for anyone else. */
function useAccounts(enabled: boolean) {
  return useQuery({ queryKey: ['accounts', 'list'], queryFn: () => engine.accounts(), enabled });
}

type Action = { kind: 'archive' | 'unarchive' | 'delete'; actor: Actor };

export function ActorsPage() {
  const { agent } = useParams({ strict: false }) as { agent: string };
  const search = useSearch({ strict: false }) as ActorsSearch;
  const navigate = useNavigate();
  const me = useMe();
  const [creating, setCreating] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const actors = useActors(agent, undefined, search.cursor);
  const pages = pageCursors(search.cursor, actors.data?.nextCursor);
  const rows = actors.data?.items;
  const writes = holds(me.data, 'actors:write');
  // Names, where this person may list them: an ID, where not.
  const machines = useMachines(holds(me.data, 'machines:manage'));
  const machineNames = new Map((machines.data?.items ?? []).map((one) => [one.id, one.name]));
  const accounts = useAccounts(holds(me.data, 'accounts:manage'));
  const accountNames = new Map((accounts.data?.items ?? []).map((one) => [one.id, one.name]));
  const to = (more: ActorsSearch) =>
    void navigate({ to: agentPath(agent, 'actors'), search: { ...search, ...more } as never });

  return (
    <div className="list-page actors-page">
      <PageHeader title="Actors">
        {writes && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            <IconPlus size={15} />
            New actor
          </Button>
        )}
      </PageHeader>
      {actors.isError && (
        <LoadError things="actors" error={actors.error} onRetry={() => void actors.refetch()} />
      )}
      {!(actors.isError && rows === undefined) && (
        <Table<Actor>
          label="Actors"
          loading={actors.isPending}
          rows={rows}
          rowKey={(actor) => actor.id}
          columns={[
            {
              name: 'Actor',
              cell: (actor) => (
                <span className="actor-cell">
                  <ActorLink
                    actor={actor.id}
                    className="ac-table__name mono"
                    title={actor.name === null ? actor.id : undefined}
                  >
                    {actorName(actor)}
                  </ActorLink>
                  {actor.parent !== null && (
                    <span className="ac-table__muted">subagent {actor.parent.name}</span>
                  )}
                </span>
              ),
            },
            { name: 'Status', cell: (actor) => <Status word={actor.status} /> },
            {
              name: 'Last turn',
              // How it ended, in a word: why, on hover, as it can be long.
              cell: (actor) =>
                actor.lastTurn === null ? (
                  <span className="ac-table__muted">{NOTHING}</span>
                ) : (
                  <span title={lastTurnWord(actor.lastTurn) ?? undefined}>
                    <Status word={actor.lastTurn.end === 'ok' ? 'ended' : actor.lastTurn.end} />
                  </span>
                ),
            },
            {
              name: 'Version',
              cell: (actor) => <span className="mono">{version(actor.deployment.version)}</span>,
            },
            {
              name: 'Model',
              cell: (actor) => <span className="mono agent-model">{actor.modelId}</span>,
            },
            {
              name: 'Account',
              cell: (actor) =>
                actor.account === null ? (
                  <span className="ac-table__muted">{NOTHING}</span>
                ) : (
                  <span className="mono" title={actor.account}>
                    {accountNames.get(actor.account) ?? actor.account}
                  </span>
                ),
            },
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
            { name: 'Created', cell: (actor) => <Ago at={actor.createdAt} /> },
            ...(writes
              ? [
                  {
                    name: 'Actions',
                    hidden: true,
                    className: 'ac-table__actions',
                    cell: (actor: Actor) => (
                      <Menu label={`Actions for ${actorName(actor)}`}>
                        {(done) =>
                          actor.archivedAt === null ? (
                            <MenuItem
                              icon={<IconArchive size={16} stroke={1.75} aria-hidden="true" />}
                              onSelect={() => {
                                done();
                                setAction({ kind: 'archive', actor });
                              }}
                            >
                              Archive
                            </MenuItem>
                          ) : (
                            <>
                              <MenuItem
                                icon={<IconArchiveOff size={16} stroke={1.75} aria-hidden="true" />}
                                onSelect={() => {
                                  done();
                                  setAction({ kind: 'unarchive', actor });
                                }}
                              >
                                Unarchive
                              </MenuItem>
                              <MenuItem
                                danger
                                icon={<IconTrash size={16} stroke={1.75} aria-hidden="true" />}
                                onSelect={() => {
                                  done();
                                  setAction({ kind: 'delete', actor });
                                }}
                              >
                                Delete
                              </MenuItem>
                            </>
                          )
                        }
                      </Menu>
                    ),
                  },
                ]
              : []),
          ]}
        />
      )}
      {rows?.length === 0 && <p className="table-empty">No actors yet</p>}
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
      {creating && <NewActor agent={agent} onClose={() => setCreating(false)} />}
      {action !== null && (
        <ActorAction key={action.actor.id} action={action} onClose={() => setAction(null)} />
      )}
    </div>
  );
}

/** Archiving, unarchiving or deleting an actor, after asking. */
function ActorAction({ action, onClose }: { action: Action; onClose: () => void }) {
  const { kind, actor } = action;
  const run = useMutation({
    mutationFn: () =>
      kind === 'archive'
        ? engine.archive(actor.id)
        : kind === 'unarchive'
          ? engine.unarchive(actor.id)
          : engine.deleteActor(actor.id),
    onSuccess: () => {
      // Its list, its page, and the accounts that count the actors given them.
      void queryClient.invalidateQueries();
      onClose();
    },
  });
  const name = actorName(actor);
  const asked = {
    archive: {
      title: `Archive ${name}?`,
      sentence: 'It takes no input while it is archived, and its subagents are archived with it.',
      action: 'Archive',
    },
    unarchive: {
      title: `Unarchive ${name}?`,
      sentence: 'It takes input again, as it did before it was archived.',
      action: 'Unarchive',
    },
    delete: {
      title: `Delete ${name}?`,
      sentence:
        'It is removed with its subagents and their conversations. What they spent stays in Usage. This can’t be undone.',
      action: 'Delete',
    },
  }[kind];
  return (
    <Confirm
      {...asked}
      danger={kind === 'delete'}
      pending={run.isPending}
      error={run.error === null ? null : errorText(run.error)}
      onConfirm={() => run.mutate()}
      onClose={onClose}
    />
  );
}

/**
 * A new actor of the agent, on its active version: its name, the model account it is called
 * with, its model and reasoning, the machine it works on where its agent's actors work on one,
 * and the configuration its agent takes. It is opened once it is made.
 */
function NewActor({ agent, onClose }: { agent: string; onClose: () => void }) {
  const navigate = useNavigate();
  const me = useMe();
  const detail = useAgent(agent);
  // What the active version declares decides the fields.
  const active = useDeployment(agent, detail.data?.activeDeployment.id);
  const listsMachines = holds(me.data, 'machines:manage');
  const machines = useMachines(listsMachines);
  // Only one who manages accounts may list them: any other is given the provider's default.
  const listsAccounts = holds(me.data, 'accounts:manage');
  const accounts = useAccounts(listsAccounts);
  const formId = useId();
  const [name, setName] = useState('');
  const [account, setAccount] = useState('');
  const [modelId, setModelId] = useState('');
  const [reasoning, setReasoning] = useState<Reasoning>('medium');
  const [machine, setMachine] = useState('');
  const [cwd, setCwd] = useState('');
  const [env, setEnv] = useState('');
  const [configuration, setConfiguration] = useState('{}');
  const [invalid, setInvalid] = useState<string | null>(null);
  const definition = active.data?.definition;
  const provider = detail.data?.provider;
  const takesConfiguration = definition !== undefined && definition.configuration !== null;
  // Its agent says whether its actors work on a machine: all of them do, or none.
  const onMachine = definition?.features?.includes('machine') === true;
  const own = (accounts.data?.items ?? []).filter((one) => one.provider === provider);
  const fallback = own.find((one) => one.default);
  const create = useMutation({
    mutationFn: (body: CreateActorRequest) => engine.createActor(agent, body),
    onSuccess: ({ actor }) => {
      void queryClient.invalidateQueries();
      onClose();
      void navigate({ to: actorPath(actor.id) });
    },
  });

  return (
    <Dialog
      title="New actor"
      pending={create.isPending}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" disabled={create.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} busy={create.isPending}>
            New actor
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
          if (create.isPending) return;
          let parsed: Json | undefined;
          if (takesConfiguration) {
            try {
              parsed = JSON.parse(configuration) as Json;
            } catch (error) {
              setInvalid(`The configuration is not JSON: ${errorText(error)}`);
              return;
            }
          }
          const variables = parseEnv(env);
          if (variables.error !== null) {
            setInvalid(variables.error);
            return;
          }
          setInvalid(null);
          create.mutate({
            ...(name.trim() === '' ? {} : { name: name.trim() }),
            ...(account === '' ? {} : { account: account as never }),
            ...(modelId.trim() === '' ? {} : { modelId: modelId.trim() }),
            reasoning,
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
        <Field label="Name">
          {(id) => (
            <input
              id={id}
              className="ac-input mono"
              value={name}
              spellCheck={false}
              placeholder="Optional"
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>
        {listsAccounts && (
          <Field label="Account">
            {() => (
              <Dropdown
                label="Account"
                value={account}
                {...(accounts.data === undefined ? { placeholder: 'Loading…' } : {})}
                empty={`No ${provider ?? ''} account yet`}
                options={
                  own.length === 0
                    ? []
                    : [
                        {
                          value: '',
                          label: fallback === undefined ? 'Default' : `Default: ${fallback.name}`,
                        },
                        ...own.map((one) => ({ value: one.id as string, label: one.name })),
                      ]
                }
                onChange={setAccount}
              />
            )}
          </Field>
        )}
        <Field label="Model">
          {(id) => (
            <input
              id={id}
              className="ac-input mono"
              value={modelId}
              spellCheck={false}
              placeholder="The provider’s default"
              onChange={(event) => setModelId(event.target.value)}
            />
          )}
        </Field>
        <Field label="Reasoning">
          {() => (
            <Dropdown
              label="Reasoning"
              value={reasoning}
              options={REASONING_LEVELS.map((level) => ({ value: level, label: level }))}
              onChange={setReasoning}
            />
          )}
        </Field>
        {onMachine && (
          <Field label="Machine">
            {(id) =>
              listsMachines ? (
                <Dropdown
                  label="Machine"
                  value={machine}
                  placeholder="Choose a machine"
                  empty="No machine yet"
                  options={(machines.data?.items ?? []).map((one) => ({
                    value: one.id as string,
                    label: one.online ? one.name : `${one.name} (offline)`,
                  }))}
                  onChange={setMachine}
                />
              ) : (
                <input
                  id={id}
                  className="ac-input mono"
                  value={machine}
                  spellCheck={false}
                  placeholder="Its ID"
                  required
                  onChange={(event) => setMachine(event.target.value)}
                />
              )
            }
          </Field>
        )}
        {onMachine && machine.trim() !== '' && (
          <>
            <Field label="Working directory">
              {(id) => (
                <input
                  id={id}
                  className="ac-input mono"
                  value={cwd}
                  spellCheck={false}
                  placeholder="~"
                  onChange={(event) => setCwd(event.target.value)}
                />
              )}
            </Field>
            <Field label="Environment">
              {(id) => (
                <textarea
                  id={id}
                  className="ac-input mono"
                  rows={3}
                  spellCheck={false}
                  value={env}
                  placeholder="NAME=value"
                  onChange={(event) => setEnv(event.target.value)}
                />
              )}
            </Field>
          </>
        )}
        {takesConfiguration && (
          <Field label="Configuration">
            {(id) => (
              <textarea
                id={id}
                className="ac-input mono"
                rows={6}
                spellCheck={false}
                value={configuration}
                onChange={(event) => setConfiguration(event.target.value)}
              />
            )}
          </Field>
        )}
      </form>
      <FormError error={invalid ?? create.error} />
    </Dialog>
  );
}
