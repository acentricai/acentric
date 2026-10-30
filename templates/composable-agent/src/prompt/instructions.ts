// The model's instructions: the system prompt every call sends. The `llm`
// handler builds them from the call's prompt args, so they depend only on
// those: the same args give the same text, which keeps the provider's
// prompt cache working.

/** What the instructions are built from, copied from the settings into each call. Empty until they need some. */
// oxlint-disable-next-line typescript/no-empty-object-type -- an agent adds its fields here
export type PromptArgs = {};

/**
 * The prompt args for a model call, from the settings. `settings` holds
 * every part's settings: name the fields the prompt needs in its type, such
 * as `{ timezone: string }`, and copy them here.
 */
export function promptArgs(_settings: object): PromptArgs {
  return {};
}

export function instructions(_args: PromptArgs): string {
  return 'You are a helpful assistant.';
}
