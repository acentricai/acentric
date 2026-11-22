// Model families: models trained alike, which behave alike in the harness, whichever provider
// serves them. OpenAI and ChatGPT serve the same GPT models; Fireworks serves several families.
// What the harness tells a family besides the others is in the scaffold, and is only what its
// models were seen to need in real runs.

export type ModelFamily = 'gpt' | 'claude' | 'kimi' | 'glm' | 'deepseek';

/** The family a model is of, by its ID, or undefined for one of none the harness knows. */
export function familyOf(modelId: string): ModelFamily | undefined {
  const id = modelId.toLowerCase();
  const name = id.slice(id.lastIndexOf('/') + 1);
  if (name.startsWith('gpt-')) return 'gpt';
  if (name.startsWith('claude-')) return 'claude';
  if (name.startsWith('kimi-')) return 'kimi';
  if (name.startsWith('glm-')) return 'glm';
  if (name.startsWith('deepseek-')) return 'deepseek';
  return undefined;
}
