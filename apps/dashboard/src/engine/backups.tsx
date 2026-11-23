// `/backups`: the server's own backups. What became of the last, where they go and whether that
// is the disk of what they back up, the bucket they are copied to and whether it is reached, how
// often one is taken and how many are kept, and those there are, on the server and in the
// bucket. One is taken when asked. A backup is not had here: it has every conversation and sealed
// secret in it, and is had from the server's folder, by whoever runs the server.

import { IconDatabaseExport } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';

import type { Backup } from '@acentric/protocol';

import { fullTime, size } from '../format.ts';
import {
  Ago,
  Button,
  FormError,
  LoadError,
  Notice,
  PageHeader,
  Skeleton,
  Table,
  useNow,
} from '../ui.tsx';
import { engine, isApiError, queryClient } from './api.ts';

export const backupQueries = { status: ['backups'] as const };

/** How often, in words: every 24 hours, every 30 minutes. */
export function everyText(ms: number): string {
  const [unit, amount] =
    ms % 86_400_000 === 0
      ? ['day', ms / 86_400_000]
      : ms % 3_600_000 === 0
        ? ['hour', ms / 3_600_000]
        : ['minute', Math.round(ms / 60_000)];
  return amount === 1 ? `every ${unit}` : `every ${String(amount)} ${unit}s`;
}

/** When a time to come is, from now: `in 40s`, `in 3m`, `in 5h`, `in 2d`. */
export function inText(at: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((at - now) / 1000));
  if (seconds < 60) return `in ${String(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in ${String(minutes)}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${String(hours)}h`;
  return `in ${String(Math.round(hours / 24))}d`;
}

/** When the next backup is taken. */
function Next({ at }: { at: number }) {
  const now = useNow();
  return <span title={fullTime(at)}>{inText(at, now)}</span>;
}

/** Where a backup is, in words. */
export function whereText(backup: Backup): string {
  if (backup.onServer && backup.inBucket) return 'Server and bucket';
  return backup.onServer ? 'Server' : 'Bucket';
}

/** What a backup is, in words. */
export function kindText(backup: Backup): string {
  if (backup.kind === 'scheduled') return 'Scheduled';
  if (backup.kind === 'manual') return 'When asked';
  return `Before the upgrade to ${backup.version}`;
}

export function BackupsPage() {
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

  return (
    <div className="list-page">
      <PageHeader title="Backups">
        {!off && (
          <Button
            variant="primary"
            busy={take.isPending}
            disabled={data === undefined}
            onClick={() => take.mutate()}
          >
            <IconDatabaseExport size={15} />
            Back up now
          </Button>
        )}
      </PageHeader>
      <FormError error={take.error} />
      {off ? (
        <Notice title="This server takes no backups of its own">
          It was started with ACENTRIC_BACKUP_EVERY=off. Back it up on the server with{' '}
          <code>acentric-server backup</code>.
        </Notice>
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
          <div className="rise">
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
                <Ago at={data.last.at} />, as <code>{data.last.name}</code>.
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
          <p className="note rise">
            {`One is taken ${everyText(data.everyMs)}, and before a new version changes the database. The newest ${String(data.keep)} of each kind are kept, in `}
            <code>{data.dir}</code>
            {' on the server'}
            {data.bucket === null ? (
              '.'
            ) : (
              <>
                {', and in '}
                <code>{data.bucket.url}</code>
                {', where each is copied.'}
              </>
            )}
          </p>
          <Table
            label="Backups"
            loading={false}
            rows={data.items}
            rowKey={(backup) => backup.name}
            columns={[
              {
                name: 'Backup',
                cell: (backup) => <span className="ac-table__name mono">{backup.name}</span>,
              },
              { name: 'Kind', cell: (backup) => kindText(backup) },
              ...(data.bucket === null
                ? []
                : [{ name: 'Where', cell: (backup: Backup) => whereText(backup) }]),
              { name: 'Size', cell: (backup) => size(backup.bytes) },
              { name: 'Taken', cell: (backup) => <Ago at={backup.createdAt} /> },
            ]}
          />
          {data.items.length === 0 && <p className="table-empty">No backups there yet.</p>}
          <p className="note rise">
            A backup does not have the key secrets are sealed with in it. Keep ACENTRIC_SECRET_KEY
            somewhere other than the server: without it, the agents’ secrets and the model accounts’
            keys in a backup do not open. A backup is put back on the server, with the server
            stopped, by <code>acentric-server restore</code>, from its file or from its URL in the
            bucket.
          </p>
        </>
      )}
    </div>
  );
}
