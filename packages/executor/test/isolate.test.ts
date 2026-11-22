import { IsolateExecutor } from '../src/index.ts';
import { executorSuite } from './executor-suite.ts';
import { turnSuite } from './turn-suite.ts';

executorSuite('in isolates of workerd', async (loading, secrets) => {
  const executor = await IsolateExecutor.start({
    processes: 1,
    secrets: (_agent, name) => secrets[name],
    log: () => {},
  });
  for (const { deployment, code, agent } of loading)
    await executor.load(deployment, { code, agent });
  return executor;
});

turnSuite('in isolates of workerd', (secrets) =>
  IsolateExecutor.start({ processes: 1, secrets, log: () => {} }),
);
