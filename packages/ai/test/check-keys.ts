// Asks each provider whether it takes the key in the environment, and that it refuses one it
// does not. Nothing is recorded. Run by hand:
//
//   OPENAI_API_KEY=… FIREWORKS_API_KEY=… ANTHROPIC_API_KEY=… node packages/ai/test/check-keys.ts

import { ModelFailure, builtInProviders } from '../src/index.ts';

const KEYS = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
} as const;

let wrong = 0;
for (const provider of builtInProviders().list()) {
  const name = (KEYS as { [id: string]: string | undefined })[provider.id];
  const apiKey = name === undefined ? undefined : process.env[name];
  if (provider.check === undefined || apiKey === undefined) {
    console.log(`${provider.id}: not checked`);
    continue;
  }
  const outcome = async (key: string): Promise<string> => {
    const started = Date.now();
    try {
      await provider.check?.({ credential: { type: 'api_key', apiKey: key } });
      return `taken, in ${String(Date.now() - started)} ms`;
    } catch (error) {
      if (!(error instanceof ModelFailure)) throw error;
      return `refused as ${error.kind}: ${error.message}`;
    }
  };
  const real = await outcome(apiKey);
  const made = await outcome(`${apiKey.slice(0, 8)}-not-a-key`);
  console.log(`${provider.id}: its key is ${real}`);
  console.log(`${provider.id}: one made up is ${made}`);
  if (!real.startsWith('taken') || !made.startsWith('refused as auth')) wrong += 1;
}
if (wrong > 0) {
  console.error(`${String(wrong)} did not answer as expected`);
  process.exit(1);
}
