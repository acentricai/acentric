// The probe's agent module, version 1: the pure half, without handlers.

import type { Agent, JsonObject } from '@acentric/types';

import { probe } from './core.js';
import type { ProbeSnapshot } from './core.js';

const agent: Agent<ProbeSnapshot, JsonObject> = { ...probe, version: '1' };

export default agent;
