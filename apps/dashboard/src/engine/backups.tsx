// The server's own backups, in words: what the Backups section of Settings reads them with.

import type { Backup } from '@acentric/protocol';

export const backupQueries = {
  status: ['backups'] as const,
  settings: ['backups', 'settings'] as const,
};

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

/** Where a backup is, in words. */
export function whereText(backup: Backup): string {
  if (backup.onServer && backup.inBucket) return 'Server and bucket';
  return backup.onServer ? 'Server' : 'Bucket';
}

/** What a backup is, in words. */
export function kindText(backup: Backup): string {
  if (backup.kind === 'scheduled') return 'Scheduled';
  if (backup.kind === 'manual') return 'Manual';
  return `Before the upgrade to ${backup.version}`;
}
