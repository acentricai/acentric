// The providers an agent's model can come from, the models of each that are known, and how
// hard a model thinks.
//
// A provider is named by its ID. The ones listed here are those the framework knows the models
// of, so that their IDs are offered as they are typed. Any other ID is taken too: a provider
// is the engine's to have, not the framework's.

/** The models known of each provider. Another module may add a provider's to it. */
export interface KnownModels {
  openai: 'gpt-6.2-astra' | 'gpt-6.2-sol' | 'gpt-6.1-terra' | 'gpt-6-luna';
  chatgpt: 'gpt-6.2-astra' | 'gpt-6.2-sol' | 'gpt-6.1-terra' | 'gpt-6-luna';
  anthropic: 'claude-fable-5-2' | 'claude-opus-5-5' | 'claude-sonnet-5-5' | 'claude-haiku-5-5';
  /** On a Claude plan, through Claude Code: only a server started with Claude has it. */
  claude: 'claude-fable-5-2' | 'claude-opus-5-5' | 'claude-sonnet-5-5' | 'claude-haiku-5-5';
  fireworks:
    | 'accounts/fireworks/models/kimi-k3p1-pro'
    | 'accounts/fireworks/models/deepseek-v4p1-flash-1017'
    | 'accounts/fireworks/models/glm-5p3-flash'
    | 'accounts/fireworks/models/glm-5p3';
}

/** A provider's ID: one the framework knows, or any other the engine has. */
export type Provider = keyof KnownModels | (string & {});

/** The model IDs known of provider `P`. */
export type KnownModelId<P extends Provider = Provider> = P extends keyof KnownModels
  ? KnownModels[P]
  : never;

/** A model ID that is known, and so offered as it is typed, or any other the provider serves. */
export type ModelId<P extends Provider = Provider> = KnownModelId<P> | (string & {});

/** How hard a model thinks. Each provider turns it into what it and the model take. */
export type Reasoning = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
