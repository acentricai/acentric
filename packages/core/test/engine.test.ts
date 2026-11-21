import { MemoryStore } from '../src/memory-store.ts';
import { engineSuite } from './engine-suite.ts';

engineSuite('in memory', async () => new MemoryStore());
