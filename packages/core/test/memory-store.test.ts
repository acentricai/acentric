import { MemoryStore } from '../src/memory-store.ts';
import { storeSuite } from './store-suite.ts';

storeSuite('in memory', async () => new MemoryStore());
