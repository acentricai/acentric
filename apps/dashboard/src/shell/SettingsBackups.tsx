// The Backups section of Settings, for one who may manage backups: how the last one went, what
// is wrong with where they go, Back up now, and the backups there are. It reads what the Backups
// page reads.

import { IconDatabaseExport } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';

import { engine, isApiError, queryClient } from '../engine/api.ts';
import { backupQueries, inText, kindText, whereText } from '../engine/backups.tsx';
import { date, fullTime, size } from '../format.ts';
import { Ago, Button, FormError, LoadError, Notice, Skeleton, useNow } from '../ui.tsx';

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

  return (
    <div className="prefs-page">
      <section className="prefs-group" aria-labelledby="prefs-backups">
        <div className="prefs-group__head prefs-group__head--spaced">
          <h3 className="prefs-group__title" id="prefs-backups">
            Backups
          </h3>
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
    </div>
  );
}
