// The model's instructions: the system prompt every call sends. The `llm`
// handler builds them from the call's prompt args, so they depend only on
// those: the same args give the same text, which keeps the provider's
// prompt cache working.

/** What the instructions are built from, copied from the settings into each call. Empty until they need some. */
// oxlint-disable-next-line typescript/no-empty-object-type -- an agent adds its fields here
export type PromptArgs = {};

export function instructions(_args: PromptArgs): string {
  return 'You are a helpful assistant.';
}
