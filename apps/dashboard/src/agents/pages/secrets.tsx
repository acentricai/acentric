// An agent's secrets: their names and when each was set, with adding, replacing and removing one.
// A value is never read back.

import type { Secret } from '@acentric/protocol';
import { IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useId, useState } from 'react';

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
import { engine, queryClient } from '../api.ts';
import { keys, useSecrets } from '../queries.ts';
import '../../machines/machine-pane.css';

type Action = { kind: 'add' } | { kind: 'replace' | 'remove'; name: string };

export function SecretsPage() {
  const { agent } = useParams({ strict: false }) as { agent: string };
  const secrets = useSecrets(agent);
  const [action, setAction] = useState<Action | null>(null);
  const rows = secrets.data?.items;
  const close = () => setAction(null);

  return (
    <div className="list-page secrets-page">
      <PageHeader title="Secrets">
        <Button variant="primary" onClick={() => setAction({ kind: 'add' })}>
          <IconPlus size={15} />
          Add secret
        </Button>
      </PageHeader>
      {secrets.isError && (
        <LoadError things="secrets" error={secrets.error} onRetry={() => void secrets.refetch()} />
      )}
      {!(secrets.isError && rows === undefined) && (
        <Table<Secret>
          label="Secrets"
          loading={secrets.isPending}
          rows={rows}
          rowKey={(secret) => secret.name}
          columns={[
            {
              name: 'Name',
              cell: (secret) => <span className="ac-table__name mono">{secret.name}</span>,
            },
            { name: 'Updated', cell: (secret) => <Ago at={secret.updatedAt} /> },
            {
              name: 'Actions',
              hidden: true,
              className: 'ac-table__actions',
              cell: (secret) => (
                <Menu label={`Actions for ${secret.name}`}>
                  {(done) => (
                    <>
                      <MenuItem
                        icon={<IconPencil size={16} stroke={1.75} aria-hidden="true" />}
                        onSelect={() => {
                          done();
                          setAction({ kind: 'replace', name: secret.name });
                        }}
                      >
                        Replace value
                      </MenuItem>
                      <MenuItem
                        danger
                        icon={<IconTrash size={16} stroke={1.75} aria-hidden="true" />}
                        onSelect={() => {
                          done();
                          setAction({ kind: 'remove', name: secret.name });
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
      )}
      {rows?.length === 0 && <p className="table-empty">No secrets yet</p>}
      {action?.kind === 'add' && (
        <SetSecret
          agent={agent}
          existing={new Set((rows ?? []).map((secret) => secret.name))}
          onClose={close}
        />
      )}
      {action?.kind === 'replace' && (
        <SetSecret key={action.name} agent={agent} name={action.name} onClose={close} />
      )}
      {action?.kind === 'remove' && (
        <RemoveSecret key={action.name} agent={agent} name={action.name} onClose={close} />
      )}
    </div>
  );
}

/**
 * Sets a secret: a new one by its name and value, or, given `name`, a new value for that one.
 * A new name that is already a secret's is asked about before its value is replaced.
 */
function SetSecret({
  agent,
  name: fixed,
  existing = new Set(),
  onClose,
}: {
  agent: string;
  name?: string;
  existing?: ReadonlySet<string>;
  onClose: () => void;
}) {
  const formId = useId();
  const [name, setName] = useState(fixed ?? '');
  const [value, setValue] = useState('');
  const [confirming, setConfirming] = useState(false);
  const set = useMutation({
    mutationFn: () => engine.setSecret(agent, name.trim(), value),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.secrets(agent) });
      onClose();
    },
  });
  if (confirming) {
    return (
      <Confirm
        title={`Replace ${name.trim()}?`}
        sentence="It is already a secret of this agent. Its value is replaced with the new one."
        action="Replace"
        pending={set.isPending}
        error={set.error === null ? null : errorText(set.error)}
        onConfirm={() => set.mutate()}
        onClose={onClose}
      />
    );
  }
  return (
    <Dialog
      title={fixed === undefined ? 'Add secret' : `Replace ${fixed}`}
      pending={set.isPending}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" disabled={set.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} busy={set.isPending}>
            {fixed === undefined ? 'Add secret' : 'Replace'}
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
          if (set.isPending || name.trim() === '' || value === '') return;
          if (fixed === undefined && existing.has(name.trim())) setConfirming(true);
          else set.mutate();
        }}
      >
        {fixed === undefined && (
          <Field label="Name">
            {(id) => (
              <input
                id={id}
                className="ac-input mono"
                required
                spellCheck={false}
                autoComplete="off"
                placeholder="API_KEY"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
        )}
        <Field label="Value">
          {(id) => (
            <input
              id={id}
              type="password"
              className="ac-input mono"
              required
              autoComplete="new-password"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          )}
        </Field>
      </form>
      <FormError error={set.error} />
    </Dialog>
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
  const remove = useMutation({
    mutationFn: () => engine.removeSecret(agent, name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.secrets(agent) });
      onClose();
    },
  });
  return (
    <Confirm
      title={`Remove ${name}?`}
      sentence="Its value is deleted, and the agent’s actors no longer have it. This can’t be undone."
      action="Remove"
      danger
      pending={remove.isPending}
      error={remove.error === null ? null : errorText(remove.error)}
      onConfirm={() => remove.mutate()}
      onClose={onClose}
    />
  );
}
