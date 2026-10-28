// The template's interrupt input: stop the turn in progress. Running effects
// are aborted, and messages waiting to steer or start the next turn are
// dropped.

import { controlInput } from './define.js';

export const interrupt = controlInput({ kind: 'interrupt', payload: {} });
