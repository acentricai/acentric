import { MemoryStore } from '../src/memory-store.ts';
import { bashSuite } from './bash-suite.ts';
import { engineSuite } from './engine-suite.ts';
import { machinesSuite } from './machines-suite.ts';
import { sandboxesSuite } from './sandboxes-suite.ts';
import { tasksSuite } from './tasks-suite.ts';

engineSuite('in memory', async () => new MemoryStore());
tasksSuite('in memory', async () => new MemoryStore());
machinesSuite('in memory', async () => new MemoryStore());
bashSuite('in memory', async () => new MemoryStore());
sandboxesSuite('in memory', async () => new MemoryStore());
