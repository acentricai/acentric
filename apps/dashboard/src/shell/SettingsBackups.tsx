// The Backups section of Settings, for one who may manage backups: how the last one went, what
// is wrong with where they go, Back up now, and the backups there are. It reads what the Backups
// page reads.

import { IconDatabaseExport, IconPower } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { engine, isApiError, queryClient } from '../engine/api.ts';
import { backupQueries, inText, kindText, whereText } from '../engine/backups.tsx';
import { date, fullTime, size } from '../format.ts';
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

function Next({ at }: { at: number }) {
  const now = useNow();
  return <span title={fullTime(at)}>{inText(at, now)}</span>;
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
          {!off && (
            <Button
              size="sm"
              busy={take.isPending}
              disabled={data === undefined}
              onClick={() => take.mutate()}
            >
              <IconDatabaseExport size={15} stroke={1.75} aria-hidden="true" />
              Back up now
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
            <div className="prefs-notices">
              {data.last === null ? (
                <Notice title="No backup has been taken since the server started">
                  {data.next !== null && (
                    <>
                      The next is taken <Next at={data.next} />.
                    </>
                  )}
                </Notice>
              ) : data.last.ok ? (
                <Notice title="The last backup was taken">
                  <Ago at={data.last.at} />.
                  {data.next !== null && (
                    <>
                      {' '}
                      The next is taken <Next at={data.next} />.
                    </>
                  )}
                </Notice>
              ) : (
                <Notice tone="danger" title="The last backup failed">
                  <Ago at={data.last.at} />: {data.last.error}
                </Notice>
              )}
              {data.bucket?.error != null && (
                <Notice tone="danger" title="The bucket backups are copied to is not reached">
                  {data.bucket.error}
                </Notice>
              )}
              {data.sameDisk && data.bucket === null && (
                <Notice tone="warn" title="The backups are on the disk of what they back up">
                  They are lost with it. Set ACENTRIC_BACKUP_URL to a bucket they are copied to as
                  well, or ACENTRIC_BACKUP_DIR to a folder of another disk.
                </Notice>
              )}
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
                      <span className="prefs-table__mono" title={backup.name}>
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
      {turningOn && <TurnOnDialog onClose={() => setTurningOn(false)} />}
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

/** Turns the server's backups on: how often, how many, and a bucket they are copied to. */
function TurnOnDialog({ onClose }: { onClose: () => void }) {
  const formId = useId();
  const [every, setEvery] = useState(String(86_400_000));
  const [keep, setKeep] = useState('3');
  const [where, setWhere] = useState<'server' | 'bucket'>('server');
  const [url, setUrl] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [region, setRegion] = useState('');
  const [keyId, setKeyId] = useState('');
  const [secret, setSecret] = useState('');
  const bucket = where === 'bucket';
  const ready = !bucket || (url.trim() !== '' && keyId.trim() !== '' && secret !== '');
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
              secretAccessKey: secret,
            }
          : null,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: backupQueries.status });
      onClose();
    },
  });
  const text = (
    label: string,
    value: string,
    set: (value: string) => void,
    more: { optional?: boolean; placeholder?: string; secret?: boolean } = {},
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
          required={more.optional !== true}
          value={value}
          onChange={(event) => set(event.target.value)}
        />
      )}
    </Field>
  );

  return (
    <Dialog
      title="Turn on backups"
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
            Turn on
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
          <Dropdown label="How often" value={every} options={EVERY} onChange={setEvery} />
        </div>
        <div className="ac-field">
          <span className="ac-field__label">Backups kept</span>
          <Dropdown label="Backups kept" value={keep} options={KEEP} onChange={setKeep} />
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
            {text('Secret access key', secret, setSecret, { secret: true })}
          </>
        )}
        <FormError error={turnOn.error} />
      </form>
    </Dialog>
  );
}
