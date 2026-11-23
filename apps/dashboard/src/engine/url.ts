// What the audit log's page reads from its URL, checked.

import { auditEventSchema } from '@acentric/protocol';

export type AuditSearch = { action?: string | undefined };

/** The kind of thing done that the log is narrowed to: `key.create`, and so on. */
export function auditSearch(search: Record<string, unknown>): AuditSearch {
  const action = search['action'];
  return {
    action:
      typeof action === 'string' && auditEventSchema.shape.action.safeParse(action).success
        ? action
        : undefined,
  };
}
