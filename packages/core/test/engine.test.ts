import { MemoryStore } from '../src/memory-store.ts';
import { engineSuite } from './engine-suite.ts';
import { tasksSuite } from './tasks-suite.ts';

engineSuite('in memory', async () => new MemoryStore());
tasksSuite('in memory', async () => new MemoryStore());
