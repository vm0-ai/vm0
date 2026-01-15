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
  codex: {
    workingDir: "/home/user/workspace",
    image: {
      production: "vm0/codex:latest",
      development: "vm0/codex:dev",
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

  // Use dev image only when NODE_ENV is explicitly "development" or "test"
  // All other cases (production, undefined, etc.) use production image
  const isDevelopment =
    process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
  return isDevelopment ? defaults.image.development : defaults.image.production;
}

/**
 * Image variants for apps
 * Maps provider + apps combination to the appropriate image
 */
const PROVIDER_APPS_IMAGES: Record<
  string,
  Record<string, { production: string; development: string }>
> = {
  "claude-code": {
    github: {
      production: "vm0/claude-code-github:latest",
      development: "vm0/claude-code-github:dev",
    },
  },
  codex: {
    github: {
      production: "vm0/codex-github:latest",
      development: "vm0/codex-github:dev",
    },
  },
};

/**
 * Parse app string into app name and tag
 * @param appString - App string in format "app" or "app:tag"
 * @returns Object with app name and tag (defaults to "latest")
 */
function parseAppString(appString: string): {
  app: string;
  tag: "latest" | "dev";
} {
  const [app, tag] = appString.split(":");
  return {
    app: app ?? appString,
    tag: tag === "dev" ? "dev" : "latest",
  };
}

/**
 * Get the default image for a provider with optional apps
 * @param provider - The provider name
 * @param apps - Optional array of apps in format "app" or "app:tag"
 * @returns Default image string or undefined if provider is not recognized
 */
export function getDefaultImageWithApps(
  provider: string,
  apps?: string[],
): string | undefined {
  const defaults = PROVIDER_DEFAULTS[provider];
  if (!defaults) return undefined;

  // Check if apps require a special image variant
  if (apps && apps.length > 0) {
    const providerApps = PROVIDER_APPS_IMAGES[provider];
    if (providerApps) {
      // Currently we only support single app (github)
      // For future: could combine apps or use most specific variant
      const firstApp = apps[0];
      if (firstApp) {
        const { app, tag } = parseAppString(firstApp);
        const appImage = providerApps[app];
        if (appImage) {
          // Use the tag from the app string (dev or latest)
          return tag === "dev" ? appImage.development : appImage.production;
        }
      }
    }
  }

  // Fall back to default image based on NODE_ENV
  const isDevelopment =
    process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
  return isDevelopment ? defaults.image.development : defaults.image.production;
}
