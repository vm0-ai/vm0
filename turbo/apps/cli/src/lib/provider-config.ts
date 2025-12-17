/**
 * Provider configuration for auto-resolving image and working_dir
 * When a provider is specified, these defaults can be used if not explicitly set
 */

export interface ProviderDefaults {
  image: string;
  workingDir: string;
}

/**
 * Mapping of provider names to their default configurations
 */
const PROVIDER_DEFAULTS: Record<string, ProviderDefaults> = {
  "claude-code": {
    image: "vm0-claude-code-dev",
    workingDir: "/home/user/workspace",
  },
};

/**
 * Get default configuration for a provider
 * @param provider - The provider name
 * @returns Provider defaults or undefined if provider is not recognized
 */
export function getProviderDefaults(
  provider: string,
): ProviderDefaults | undefined {
  return PROVIDER_DEFAULTS[provider];
}

/**
 * Check if a provider is supported (has default configuration)
 * @param provider - The provider name
 * @returns True if provider is supported
 */
export function isProviderSupported(provider: string): boolean {
  return provider in PROVIDER_DEFAULTS;
}

/**
 * Get the list of supported providers
 * @returns Array of supported provider names
 */
export function getSupportedProviders(): string[] {
  return Object.keys(PROVIDER_DEFAULTS);
}
