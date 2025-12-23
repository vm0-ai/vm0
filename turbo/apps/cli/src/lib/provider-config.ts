/**
 * Provider configuration for auto-resolving working_dir and image
 * When a provider is specified, these defaults can be used if not explicitly set
 */

export interface ProviderDefaults {
  workingDir: string;
  image: {
    production: string;
    development: string;
  };
}

/**
 * Mapping of provider names to their default configurations
 */
const PROVIDER_DEFAULTS: Record<string, ProviderDefaults> = {
  "claude-code": {
    workingDir: "/home/user/workspace",
    image: {
      production: "vm0/claude-code:latest",
      development: "vm0/claude-code:dev",
    },
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

/**
 * Get the default image for a provider based on the current environment
 * @param provider - The provider name
 * @returns Default image string or undefined if provider is not recognized
 */
export function getDefaultImage(provider: string): string | undefined {
  const defaults = PROVIDER_DEFAULTS[provider];
  if (!defaults) return undefined;

  const isCI = process.env.CI === "true";
  const isDev = process.env.NODE_ENV === "development";
  return isCI || isDev ? defaults.image.development : defaults.image.production;
}
