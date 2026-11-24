// The Backups section of Settings, for one who may manage backups: how the last one went, what
// is wrong with where they go, Back up now, and the backups there are. It reads what the Backups
// page reads.

import { IconDatabaseExport, IconPencil, IconPower } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { engine, isApiError, queryClient } from '../engine/api.ts';
import { backupQueries, everyText, inText, kindText, whereText } from '../engine/backups.tsx';
import type { BackupSettings } from '@acentric/protocol';
import { date, fullTime, longTime, size } from '../format.ts';
import {
  Ago,
  Button,
  Dialog,
  Dropdown,
  Field,
  FormError,
  LoadError,
  Notice,
  Segmented,
  Skeleton,
  useNow,
} from '../ui.tsx';

/** When the next is taken, as a time, and how soon on hover. */
function Next({ at }: { at: number }) {
  const now = useNow();
  return <span title={inText(at, now)}>{longTime(at)}</span>;
}

export function BackupsSettings() {
  const status = useQuery({
    queryKey: backupQueries.status,
    queryFn: ({ signal }) => engine.backups(signal),
    refetchInterval: 30_000,
  });
  const take = useMutation({
    mutationFn: () => engine.takeBackup(),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: backupQueries.status }),
  });
  const off = isApiError(status.error, 503);
  const data = status.data;
  const [turningOn, setTurningOn] = useState(false);
  const [editing, setEditing] = useState(false);
  const [turningOff, setTurningOff] = useState(false);

  return (
    <div className="prefs-page">
      <section className="prefs-group" aria-labelledby="prefs-backups">
        <div className="prefs-group__head prefs-group__head--spaced">
          <h3 className="prefs-group__title" id="prefs-backups">
            Backups
          </h3>
          {off && (
            <Button size="sm" onClick={() => setTurningOn(true)}>
              <IconPower size={15} stroke={1.75} aria-hidden="true" />
              Turn on
            </Button>
          )}
          {!off && data !== undefined && (
            <Button size="sm" onClick={() => setTurningOff(true)}>
              <IconPower size={15} stroke={1.75} aria-hidden="true" />
              Turn off
            </Button>
          )}
        </div>
        <FormError error={take.error} />
        {off ? (
          <Notice title="Backups are not yet enabled" />
        ) : status.isPending ? (
          <Skeleton rows={3} label="Loading the backups" />
        ) : data === undefined ? (
          <LoadError
            things="the backups"
            error={status.error}
            onRetry={() => void status.refetch()}
          />
        ) : (
          <>
            {(data.last?.ok === false || data.bucket?.error != null) && (
              <div className="prefs-notices">
                {data.last?.ok === false && (
                  <Notice tone="danger" title="The last backup failed">
                    <Ago at={data.last.at} />: {data.last.error}
                  </Notice>
                )}
                {data.bucket?.error != null && (
                  <Notice tone="danger" title="The bucket backups are copied to is not reached">
                    {data.bucket.error}
                  </Notice>
                )}
              </div>
            )}
            <div className="prefs-rows">
              <div className="prefs-row">
                <span className="prefs-row__name">Next backup</span>
                <span className="prefs-row__form">
                  <button
                    type="button"
                    className={`prefs-row__act${take.isPending ? ' prefs-row__act--shown' : ''}`}
                    aria-label="Back up now"
                    title="Back up now"
                    disabled={take.isPending}
                    onClick={() => take.mutate()}
                  >
                    <IconDatabaseExport size={16} stroke={1.75} aria-hidden="true" />
                  </button>
                  <span className="prefs-row__plain">
                    {data.next === null ? '—' : <Next at={data.next} />}
                  </span>
                </span>
              </div>
              <div className="prefs-row">
                <span className="prefs-row__name">Stored on</span>
                <span className="prefs-row__form">
                  <button
                    type="button"
                    className="prefs-row__act"
                    aria-label="Change"
                    title="Change"
                    onClick={() => setEditing(true)}
                  >
                    <IconPencil size={16} stroke={1.75} aria-hidden="true" />
                  </button>
                  <span
                    className="prefs-row__plain"
                    title={data.bucket === null ? undefined : data.bucket.url}
                  >
                    {data.bucket === null ? 'Server' : 'Server and bucket'}
                  </span>
                </span>
              </div>
            </div>
            <table className="prefs-table" aria-label="Backups">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Kind</th>
                  {data.bucket !== null && <th scope="col">Where</th>}
                  <th scope="col">Size</th>
                  <th scope="col">Taken</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((backup) => (
                  <tr key={backup.name}>
                    <td>
                      <span className="prefs-table__mono prefs-table__cut" title={backup.name}>
                        {backup.name}
                      </span>
                    </td>
                    <td>{kindText(backup)}</td>
                    {data.bucket !== null && <td>{whereText(backup)}</td>}
                    <td>{size(backup.bytes)}</td>
                    <td title={fullTime(backup.createdAt)}>{date(backup.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.items.length === 0 && <p className="prefs-empty">No backups yet</p>}
          </>
        )}
      </section>
      {turningOn && <SettingsDialog onClose={() => setTurningOn(false)} />}
      {editing && <EditSettings onClose={() => setEditing(false)} />}
      {turningOff && data !== undefined && (
        <TurnOffDialog
          everyMs={data.everyMs}
          keep={data.keep}
          onClose={() => setTurningOff(false)}
        />
      )}
    </div>
  );
}

const EVERY = [
  { value: String(3_600_000), label: 'Every hour' },
  { value: String(6 * 3_600_000), label: 'Every 6 hours' },
  { value: String(12 * 3_600_000), label: 'Every 12 hours' },
  { value: String(86_400_000), label: 'Every day' },
  { value: String(7 * 86_400_000), label: 'Every week' },
];
const KEEP = ['1', '3', '5', '7', '14', '30'].map((value) => ({ value, label: value }));

/** The settings as they are, read first, to change them. */
function EditSettings({ onClose }: { onClose: () => void }) {
  const settings = useQuery({
    queryKey: backupQueries.settings,
    queryFn: ({ signal }) => engine.backupSettings(signal),
  });
  if (settings.data === undefined) {
    return settings.isError ? (
      <Dialog title="Backup settings" onClose={onClose}>
        <LoadError
          things="the backup settings"
          error={settings.error}
          onRetry={() => void settings.refetch()}
        />
      </Dialog>
    ) : null;
  }
  return <SettingsDialog current={settings.data} onClose={onClose} />;
}

/** An option for a value the list does not have: as it was set. */
const withValue = (
  options: readonly { readonly value: string; readonly label: string }[],
  value: string,
  label: string,
) => (options.some((option) => option.value === value) ? options : [...options, { value, label }]);

/**
 * How the server backs itself up: how often, how many, and a bucket they are copied to. Without
 * `current`, it turns them on.
 */
function SettingsDialog({ current, onClose }: { current?: BackupSettings; onClose: () => void }) {
  const formId = useId();
  const was = current?.bucket ?? null;
  const [every, setEvery] = useState(String(current?.everyMs ?? 86_400_000));
  const [keep, setKeep] = useState(String(current?.keep ?? 3));
  const [where, setWhere] = useState<'server' | 'bucket'>(was === null ? 'server' : 'bucket');
  const [url, setUrl] = useState(was?.url ?? '');
  const [endpoint, setEndpoint] = useState(was?.endpoint ?? '');
  const [region, setRegion] = useState(was?.region ?? '');
  const [keyId, setKeyId] = useState(was?.accessKeyId ?? '');
  const [secret, setSecret] = useState('');
  const bucket = where === 'bucket';
  // The secret set before is kept for the same key.
  const secretKept = was !== null && was.accessKeyId !== null && keyId.trim() === was.accessKeyId;
  const ready =
    !bucket || (url.trim() !== '' && keyId.trim() !== '' && (secret !== '' || secretKept));
  const turnOn = useMutation({
    mutationFn: () =>
      engine.setBackupSettings({
        enabled: true,
        everyMs: Number(every),
        keep: Number(keep),
        bucket: bucket
          ? {
              url: url.trim(),
              ...(endpoint.trim() === '' ? {} : { endpoint: endpoint.trim() }),
              ...(region.trim() === '' ? {} : { region: region.trim() }),
              accessKeyId: keyId.trim(),
              ...(secret === '' ? {} : { secretAccessKey: secret }),
            }
          : null,
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: backupQueries.status }),
        queryClient.invalidateQueries({ queryKey: backupQueries.settings }),
      ]);
      onClose();
    },
  });
  const text = (
    label: string,
    value: string,
    set: (value: string) => void,
    more: { optional?: boolean; placeholder?: string; secret?: boolean; required?: boolean } = {},
  ) => (
    <Field label={label} optional={more.optional ?? false}>
      {(id) => (
        <input
          id={id}
          className="ac-input"
          type={more.secret === true ? 'password' : 'text'}
          autoComplete="off"
          spellCheck={false}
          placeholder={more.placeholder}
          required={more.required ?? more.optional !== true}
          value={value}
          onChange={(event) => set(event.target.value)}
        />
      )}
    </Field>
  );

  return (
    <Dialog
      title={current === undefined ? 'Turn on backups' : 'Backup settings'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            busy={turnOn.isPending}
            disabled={!ready}
          >
            {current === undefined ? 'Turn on' : 'Save'}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !turnOn.isPending) turnOn.mutate();
        }}
      >
        <div className="ac-field">
          <span className="ac-field__label">How often</span>
          <Dropdown
            label="How often"
            value={every}
            options={withValue(EVERY, every, everyText(Number(every)))}
            onChange={setEvery}
          />
        </div>
        <div className="ac-field">
          <span className="ac-field__label">Backups kept</span>
          <Dropdown
            label="Backups kept"
            value={keep}
            options={withValue(KEEP, keep, keep)}
            onChange={setKeep}
          />
        </div>
        <div className="ac-field">
          <span className="ac-field__label">Where</span>
          <Segmented
            label="Where"
            value={where}
            options={[
              ['server', 'Server'],
              ['bucket', 'Server and bucket'],
            ]}
            onChange={setWhere}
          />
        </div>
        {bucket && (
          <>
            {text('Bucket URL', url, setUrl, { placeholder: 's3://bucket/folder' })}
            {text('Endpoint', endpoint, setEndpoint, {
              optional: true,
              placeholder: 'https://…',
            })}
            {text('Region', region, setRegion, { optional: true, placeholder: 'us-east-1' })}
            {text('Access key ID', keyId, setKeyId)}
            {text('Secret access key', secret, setSecret, {
              secret: true,
              ...(secretKept ? { placeholder: '••••••••', required: false } : {}),
            })}
          </>
        )}
        <FormError error={turnOn.error} />
      </form>
    </Dialog>
  );
}

/** Turns the server's backups off, once asked whether to. */
function TurnOffDialog({
  everyMs,
  keep,
  onClose,
}: {
  everyMs: number;
  keep: number;
  onClose: () => void;
}) {
  const turnOff = useMutation({
    mutationFn: () => engine.setBackupSettings({ enabled: false, everyMs, keep, bucket: null }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: backupQueries.status }),
        queryClient.invalidateQueries({ queryKey: backupQueries.settings }),
      ]);
      onClose();
    },
  });
  return (
    <Dialog
      title="Turn off backups?"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} data-autofocus>
            Cancel
          </Button>
          <Button variant="danger" busy={turnOff.isPending} onClick={() => turnOff.mutate()}>
            Turn off
          </Button>
        </>
      }
    >
      <FormError error={turnOff.error} />
    </Dialog>
  );
}
