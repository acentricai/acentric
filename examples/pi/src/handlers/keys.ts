// Which secret holds each provider's API key: pi-ai's standard names.

const NAMES: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
};

/** The secret holding `provider`'s API key, such as ANTHROPIC_API_KEY. */
export function apiKeySecret(provider: string): string {
  return NAMES[provider] ?? `${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
}
