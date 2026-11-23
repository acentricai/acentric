import { MemoryStore } from '../src/memory-store.ts';
import { bashSuite } from './bash-suite.ts';
import { compactionSuite } from './compaction-suite.ts';
import { engineSuite } from './engine-suite.ts';
import { machinesSuite } from './machines-suite.ts';
import { sandboxesSuite } from './sandboxes-suite.ts';
import { scheduleSuite } from './schedule-suite.ts';
import { subagentsSuite } from './subagents-suite.ts';
import { tasksSuite } from './tasks-suite.ts';

engineSuite('in memory', async () => new MemoryStore());
tasksSuite('in memory', async () => new MemoryStore());
machinesSuite('in memory', async () => new MemoryStore());
bashSuite('in memory', async () => new MemoryStore());
sandboxesSuite('in memory', async () => new MemoryStore());
scheduleSuite('in memory', async () => new MemoryStore());
subagentsSuite('in memory', async () => new MemoryStore());
compactionSuite('in memory', async () => new MemoryStore());
