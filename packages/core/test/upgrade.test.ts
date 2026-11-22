import { MemoryStore } from '../src/memory-store.ts';
import { upgradeSuite } from './upgrade-suite.ts';

upgradeSuite('in memory', async () => new MemoryStore());
