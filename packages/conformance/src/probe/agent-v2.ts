// The probe's agent module, version 2: version 1 plus migrate, for upgrade
// scenarios. Migrating rejects when the instance's config holds
// `rejectMigrate: true`; otherwise it records the version it came from.

import type { Agent, JsonObject } from '@acentric/types';

import { probe } from './core.js';
import type { ProbeSnapshot } from './core.js';

const agent: Agent<ProbeSnapshot & { migratedFrom?: string }, JsonObject> = {
  ...probe,
  version: '2',
  migrate: (snapshot, config, from) => {
    if (config['rejectMigrate'] === true) return { error: 'migrate rejected' };
    const declared = snapshot['declared'];
    const windowStart = snapshot['windowStart'];
    return {
      snapshot: {
        declared: Array.isArray(declared) ? declared.filter(isRequest) : [],
        windowStart: typeof windowStart === 'number' ? windowStart : 1,
        migratedFrom: from,
      },
    };
  },
};

function isRequest(value: unknown): value is ProbeSnapshot['declared'][number] {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'key') === 'string' &&
    typeof Reflect.get(value, 'kind') === 'string'
  );
}

export default agent;
