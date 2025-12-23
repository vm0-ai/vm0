/**
 * Provider utilities
 *
 * Defines supported providers and validation functions.
 */

/**
 * Supported provider identifiers
 */
export const SUPPORTED_PROVIDERS = ["claude-code", "codex"] as const;

export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

/**
 * Check if a provider is supported
 */
export function isSupportedProvider(
  provider: string | undefined,
): provider is SupportedProvider {
  if (!provider) return false;
  return SUPPORTED_PROVIDERS.includes(provider as SupportedProvider);
}

/**
 * Assert that a provider is supported, throwing an error if not
 *
 * @param provider - The provider to validate
 * @param context - Optional context for the error message (e.g., function name)
 * @throws Error if provider is not supported
 */
export function assertSupportedProvider(
  provider: string | undefined,
  context?: string,
): asserts provider is SupportedProvider {
  if (!isSupportedProvider(provider)) {
    const contextMsg = context ? ` in ${context}` : "";
    throw new Error(
      `Unsupported provider "${provider}"${contextMsg}. Supported providers: ${SUPPORTED_PROVIDERS.join(", ")}`,
    );
  }
}

/**
 * Get a validated provider, defaulting to claude-code if undefined
 *
 * Use this for functions where undefined provider should default to claude-code.
 * Throws an error for unknown providers.
 *
 * @param provider - The provider to validate (undefined defaults to claude-code)
 * @returns The validated provider
 * @throws Error if provider is defined but not supported
 */
export function getValidatedProvider(
  provider: string | undefined,
): SupportedProvider {
  if (provider === undefined) {
    return "claude-code";
  }
  assertSupportedProvider(provider);
  return provider;
}

/**
 * Provider display names for UI
 */
const PROVIDER_DISPLAY_NAMES: Record<SupportedProvider, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

/**
 * Get the display name for a provider
 *
 * @param provider - The provider identifier
 * @returns The human-readable display name
 * @throws Error if provider is not supported
 */
export function getProviderDisplayName(provider: string): string {
  assertSupportedProvider(provider);
  return PROVIDER_DISPLAY_NAMES[provider];
}
