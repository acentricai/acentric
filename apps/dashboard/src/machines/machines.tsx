// `/machines`: the engine's machines, with a new enrolment token and remove in each row, and how
// to add one. Filters under the heading show those of the types chosen, personal machines, which no provider made, and each sandbox account's; and those the
// actors of the agents chosen, or the actors chosen, work on.

import { IconKey, IconPlus, IconRefresh, IconTrash } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useId, useState } from 'react';

import type { Machine, MachineToken } from '@acentric/protocol';

import { queryClient } from '../api.ts';
import { engine, shellQuote } from './api.ts';
import { PERSONAL } from '../url.ts';
import type { MachinesFilter } from '../url.ts';
import { fullTime } from './format.ts';
import { AgentFilter } from './agent-filter.tsx';
import { keys, useAgents, useMachines, useProviders } from './queries.ts';
import { sandboxDeletion } from './sandboxes.tsx';
import { displayText, safeText } from './text.tsx';
import {
  Ago,
  Button,
  Command,
  Confirm,
  CopyButton,
  Dialog,
  errorText,
  Field,
  FormError,
  LoadError,
  Menu,
  MenuItem,
  FilterChip,
  PageHeader,
  Status,
  Table,
} from './ui.tsx';
import type { Choice } from './ui.tsx';

import './machine-pane.css';

function MachineStatus({ machine }: { machine: Machine }) {
  const word = machine.online
    ? 'Online'
    : !machine.enrolled
      ? 'Not enrolled'
      : machine.lastSeenAt === null
        ? 'Never connected'
        : 'Offline';
  return (
    <span className="machine-status">
      <Status word={word} tone={machine.online ? 'running' : 'idle'} />
      {!machine.online && machine.lastSeenAt !== null && (
        <span className="note">
          last seen <Ago at={machine.lastSeenAt} />
        </span>
      )}
    </span>
  );
}

const SYSTEMS: Record<string, string> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };

const system = (m: Machine) =>
  m.os === null ? null : `${SYSTEMS[m.os] ?? m.os}${m.arch === null ? '' : ` · ${m.arch}`}`;

/** What the row menu opened: a dialog for one machine. */
type Action = { kind: 'token' | 'update' | 'remove'; machine: Machine };

/** Whether a machine is of one of the types chosen: none chosen is every machine. */
export function ofTypes(machine: Machine, types: readonly string[]): boolean {
  return types.length === 0 || types.includes(machine.provider ?? PERSONAL);
}

export function MachinesPage({
  types = [],
  agents = [],
  actors = [],
  onToggle = () => {},
  onClear = () => {},
}: {
  /** The types the filter has chosen: `personal`, and the IDs of sandbox accounts. */
  types?: readonly string[];
  /** The agents and the actors whose machines are shown. */
  agents?: readonly string[];
  actors?: readonly string[];
  /** Ticks a choice of a filter, or unticks it. */
  onToggle?: (filter: MachinesFilter, value: string) => void;
  /** Clears a filter: the Agents filter is its agents and its actors. */
  onClear?: (filter: 'type' | 'agents') => void;
}) {
  const deployed = useAgents();
  // An agent that is no longer there filters nothing out.
  const agentsChosen =
    deployed.data === undefined
      ? agents
      : agents.filter((agent) => deployed.data.some((one) => one.id === agent));
  const machines = useMachines(true, { agents: agentsChosen, actors });
  const byActors = agentsChosen.length > 0 || actors.length > 0;
  const providers = useProviders();
  const choices: Choice[] = [
    { value: PERSONAL, label: 'Personal' },
    ...(providers.data?.items ?? []).map((provider) => ({
      value: provider.id,
      label: provider.name,
    })),
  ];
  // A type that is no longer there filters nothing out.
  const chosen = types.filter((type) => choices.some((choice) => choice.value === type));
  const shown = machines.data?.items.filter((machine) => ofTypes(machine, chosen));
  const [adding, setAdding] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  return (
    <div className="list-page machines-page">
      <PageHeader title="Machines">
        <Button variant="primary" onClick={() => setAdding(true)}>
          <IconPlus size={15} />
          Add a machine
        </Button>
      </PageHeader>
      <div className="filter-bar rise">
        <FilterChip
          name="Type"
          choices={choices}
          chosen={chosen}
          onToggle={(type) => onToggle('type', type)}
          onClear={() => onClear('type')}
        />
        <AgentFilter
          agents={agentsChosen}
          actors={actors}
          onToggleAgent={(agent) => onToggle('agent', agent)}
          onToggleActor={(actor) => onToggle('actor', actor)}
          onClear={() => onClear('agents')}
        />
      </div>
      {(machines.isError || machines.failureReason !== null) && (
        <LoadError
          things="machines"
          error={machines.error ?? machines.failureReason}
          retrying={machines.isFetching && machines.failureCount > 0}
          onRetry={() => void machines.refetch()}
        />
      )}
      <Table
        label="Machines"
        loading={machines.isPending}
        rows={shown}
        rowKey={(m) => m.id}
        columns={[
          {
            name: 'Machine',
            cell: (m) => (
              <span className="ac-table__name mono" title={m.id}>
                {displayText(m.name)}
              </span>
            ),
          },
          { name: 'Status', cell: (m) => <MachineStatus machine={m} /> },
          {
            name: 'System',
            cell: (m) => {
              const text = system(m);
              return text === null ? (
                <span className="ac-table__muted">—</span>
              ) : (
                <span title={m.hostname ?? undefined}>{displayText(text)}</span>
              );
            },
          },
          {
            name: 'Daemon',
            cell: (m) =>
              m.version === null ? (
                <span className="ac-table__muted">—</span>
              ) : (
                <span className="machine-daemon">
                  <code>{displayText(m.version)}</code>
                  {m.current === false && <span className="note">out of date</span>}
                </span>
              ),
          },
          { name: 'Added', cell: (m) => <Ago at={m.createdAt} /> },
          {
            name: 'Actions',
            hidden: true,
            className: 'ac-table__actions',
            cell: (m) => (
              <Menu label={`Actions for ${safeText(m.name)}`}>
                {(close) => (
                  <>
                    {m.online && m.current === false && (
                      <MenuItem
                        icon={<IconRefresh size={16} stroke={1.75} aria-hidden="true" />}
                        onSelect={() => {
                          close();
                          setAction({ kind: 'update', machine: m });
                        }}
                      >
                        Update daemon
                      </MenuItem>
                    )}
                    {m.provider === null && (
                      <MenuItem
                        icon={<IconKey size={16} stroke={1.75} aria-hidden="true" />}
                        onSelect={() => {
                          close();
                          setAction({ kind: 'token', machine: m });
                        }}
                      >
                        Enrol again
                      </MenuItem>
                    )}
                    <MenuItem
                      danger
                      icon={<IconTrash size={16} stroke={1.75} aria-hidden="true" />}
                      onSelect={() => {
                        close();
                        setAction({ kind: 'remove', machine: m });
                      }}
                    >
                      Remove
                    </MenuItem>
                  </>
                )}
              </Menu>
            ),
          },
        ]}
      />
      {machines.data?.items.length === 0 && !byActors ? (
        <p className="table-empty">No machines. Add one to give actors a place to run commands.</p>
      ) : (
        shown?.length === 0 && <p className="table-empty">No machines match the filters.</p>
      )}
      {adding && <AddDialog onClose={() => setAdding(false)} />}
      {action?.kind === 'token' && (
        <TokenDialog
          key={action.machine.id}
          machine={action.machine}
          onClose={() => setAction(null)}
        />
      )}
      {action?.kind === 'update' && (
        <UpdateDialog
          key={action.machine.id}
          machine={action.machine}
          onClose={() => setAction(null)}
        />
      )}
      {action?.kind === 'remove' && (
        <RemoveDialog
          key={action.machine.id}
          machine={action.machine}
          onClose={() => setAction(null)}
        />
      )}
    </div>
  );
}

/**
 * The one command that installs the machine program from this engine, enrols the machine with
 * its token, and keeps it connected as a service.
 */
export function installCommand(token: MachineToken, server = location.origin): string {
  return `curl -fsSL ${shellQuote(`${server}/install.sh`)} | sh -s -- --id ${shellQuote(token.machine.id)} --token ${shellQuote(token.token)}`;
}

/** The same, for a machine that has the program already: enrol, then connect. */
export function enrolCommands(token: MachineToken, server = location.origin): readonly string[] {
  return [
    `acentric-machine enrol --server ${shellQuote(server)} --id ${shellQuote(token.machine.id)} --token ${shellQuote(token.token)}`,
    'acentric-machine connect',
  ];
}

/** A token, and the commands that use it: shown once, and gone when the dialog closes. */
function Enrol({ token }: { token: MachineToken }) {
  return (
    <>
      <p className="note">
        Run this on the machine, macOS or Linux. It installs the machine program from this engine,
        enrols the machine, and keeps it connected as a service. The token works once, until{' '}
        {fullTime(token.expiresAt)} at the latest, and is not shown again.
      </p>
      <Command text={installCommand(token)} />
      <p className="note">With the machine program installed already:</p>
      <ol className="connect-steps">
        {enrolCommands(token).map((text) => (
          <li key={text}>
            <Command text={text} />
          </li>
        ))}
      </ol>
      <div className="ac-field">
        <span className="ac-field__label">Token</span>
        <div className="secret-once">
          <code className="secret-once__value" dir="ltr">
            {displayText(token.token)}
          </code>
          <CopyButton value={token.token} what="token" text />
        </div>
      </div>
    </>
  );
}

/**
 * `POST /v1/machines`: a name, then the token its daemon enrols with. It is for every agent, and
 * any deployed later: which agents it is for is changed from the list.
 */
function AddDialog({ onClose }: { onClose: () => void }) {
  const [id, setId] = useState('');
  const form = useId();
  const add = useMutation({
    mutationFn: () => engine.addMachine(id.trim(), '*'),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.machines }),
  });
  if (add.data !== undefined) {
    return (
      <Dialog
        title={`Enrol ${add.data.machine.name}`}
        onClose={onClose}
        wide
        footer={
          <Button variant="primary" onClick={onClose} data-autofocus>
            Done
          </Button>
        }
      >
        <Enrol token={add.data} />
      </Dialog>
    );
  }
  return (
    <Dialog
      title="Add a machine"
      pending={add.isPending}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" disabled={add.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={form}
            variant="primary"
            busy={add.isPending}
            disabled={!id.trim()}
          >
            Add machine
          </Button>
        </>
      }
    >
      <form
        id={form}
        className="dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (id.trim() && !add.isPending) add.mutate();
        }}
      >
        <Field label="Name">
          {(field) => (
            <input
              id={field}
              required
              className="ac-input mono"
              maxLength={63}
              spellCheck={false}
              placeholder="build-box"
              value={id}
              onChange={(e) => setId(e.target.value)}
            />
          )}
        </Field>
      </form>
      <FormError error={add.error} />
    </Dialog>
  );
}

/** `POST /v1/machines/:machine/token`: for a daemon that lost its folder, or a new machine in its place. */
function TokenDialog({ machine, onClose }: { machine: Machine; onClose: () => void }) {
  const token = useMutation({ mutationFn: () => engine.machineToken(machine.id) });
  return (
    <Dialog
      title={`Enrol ${machine.name} again`}
      pending={token.isPending}
      onClose={onClose}
      wide={token.data !== undefined}
      footer={
        token.data === undefined ? (
          <>
            <Button variant="quiet" disabled={token.isPending} onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" busy={token.isPending} onClick={() => token.mutate()}>
              New token
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={onClose} data-autofocus>
            Done
          </Button>
        )
      }
    >
      {token.data === undefined ? (
        <p className="note">
          A new token lets a daemon enrol as this machine. The daemon enrolled now keeps working
          until another enrols in its place.
        </p>
      ) : (
        <Enrol token={token.data} />
      )}
      <FormError error={token.error} />
    </Dialog>
  );
}

/** `DELETE /v1/machines/:machine`, after its exact name is typed. */
function UpdateDialog({ machine, onClose }: { machine: Machine; onClose: () => void }) {
  const update = useMutation({
    mutationFn: () => engine.upgradeMachine(machine.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.machines });
      onClose();
    },
  });
  return (
    <Confirm
      title={`Update ${machine.name}`}
      sentence="Its daemon takes this engine’s build of the machine program and starts again as it. The machine is back online once it has."
      action="Update"
      pending={update.isPending}
      error={update.error === null ? null : errorText(update.error)}
      onConfirm={() => update.mutate()}
      onClose={onClose}
    />
  );
}

function RemoveDialog({ machine, onClose }: { machine: Machine; onClose: () => void }) {
  const [confirmation, setConfirmation] = useState('');
  // A sandbox is said to be deleted at its provider, by the provider's name where it is known.
  const providers = useProviders(machine.provider !== null);
  const kind = providers.data?.items.find((provider) => provider.id === machine.provider)?.kind;
  const remove = useMutation({
    mutationFn: () => engine.removeMachine(machine.id),
    onSuccess: () => {
      // A sandbox goes with its machine: the accounts' counts and lists change too.
      void queryClient.invalidateQueries({ queryKey: keys.all });
      onClose();
    },
  });
  return (
    <Dialog
      title={`Remove ${machine.name}?`}
      pending={remove.isPending}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" disabled={remove.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={confirmation !== machine.name}
            busy={remove.isPending}
            onClick={() => remove.mutate()}
          >
            Remove machine
          </Button>
        </>
      }
    >
      <p className="note">
        {machine.provider === null
          ? 'This disconnects its daemon for good. Commands still running on it are lost, and actors on it can no longer run commands.'
          : sandboxDeletion(kind)}
      </p>
      <Field label={`Type ${safeText(machine.name)} to confirm`}>
        {(id) => (
          <input
            id={id}
            className="ac-input"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
          />
        )}
      </Field>
      <FormError error={remove.error} />
    </Dialog>
  );
}
