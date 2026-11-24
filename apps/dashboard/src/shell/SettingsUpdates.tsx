// The Updates section of Settings, for one who runs the server: its version, whether there is a
// newer one, and what changed in each version after it, as GitHub's releases say. Taking one is
// done where the server runs.

import { IconExternalLink, IconRefresh } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';

import { engine, queryClient } from '../engine/api.ts';
import { date } from '../format.ts';
import { Markdown } from '../markdown.tsx';
import { Ago, Button, FormError, LoadError, Notice, Skeleton } from '../ui.tsx';

export const updateQueries = { status: ['updates'] as const };

export function UpdatesSettings() {
  const status = useQuery({
    queryKey: updateQueries.status,
    queryFn: ({ signal }) => engine.updates(false, signal),
  });
  const check = useMutation({
    mutationFn: () => engine.updates(true),
    onSuccess: (said) => queryClient.setQueryData(updateQueries.status, said),
  });
  const data = status.data;

  return (
    <div className="prefs-page">
      <section className="prefs-group" aria-labelledby="prefs-updates">
        <div className="prefs-group__head prefs-group__head--spaced">
          <h3 className="prefs-group__title" id="prefs-updates">
            Updates
          </h3>
          {data !== undefined && data.check !== 'off' && (
            <Button size="sm" busy={check.isPending} onClick={() => check.mutate()}>
              <IconRefresh size={15} stroke={1.75} aria-hidden="true" />
              Check now
            </Button>
          )}
        </div>
        <FormError error={check.error} />
        {status.isPending ? (
          <Skeleton rows={3} label="Loading the updates" />
        ) : data === undefined ? (
          <LoadError
            things="the updates"
            error={status.error}
            onRetry={() => void status.refetch()}
          />
        ) : (
          <>
            {(data.next !== null || data.check !== 'ok') && (
              <div className="prefs-notices">
                {data.next !== null && <Notice title={`Version ${data.next} is available`} />}
                {data.check === 'failed' && (
                  <Notice tone="danger" title="Updates could not be checked">
                    {data.error}
                  </Notice>
                )}
                {data.check === 'off' && <Notice title="Update checks are off" />}
              </div>
            )}
            <div className="prefs-rows">
              <div className="prefs-row">
                <span className="prefs-row__name">Current version</span>
                <span className="prefs-row__plain">{data.current}</span>
              </div>
              {data.check !== 'off' && (
                <>
                  <div className="prefs-row">
                    <span className="prefs-row__name">Latest version</span>
                    <span className="prefs-row__plain">{data.latest ?? 'Up to date'}</span>
                  </div>
                  <div className="prefs-row">
                    <span className="prefs-row__name">Last checked</span>
                    <span className="prefs-row__plain">
                      {data.checkedAt === null ? '—' : <Ago at={data.checkedAt} />}
                    </span>
                  </div>
                </>
              )}
            </div>
            {data.releases.length > 0 && (
              <div className="prefs-releases" aria-label="Releases">
                {data.releases.map((release) => (
                  <article key={release.version} className="prefs-release">
                    <header className="prefs-release__head">
                      <span className="prefs-release__version">{release.version}</span>
                      <span className="prefs-release__date">{date(release.publishedAt)}</span>
                      {release.url !== '' && (
                        <a
                          className="prefs-release__link"
                          href={release.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`${release.version} on GitHub`}
                          title="On GitHub"
                        >
                          <IconExternalLink size={15} stroke={1.75} aria-hidden="true" />
                        </a>
                      )}
                    </header>
                    <Markdown text={release.notes} className="md" />
                  </article>
                ))}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
