/**
 * Framework configuration for auto-resolving working_dir and image
 * When a framework is specified, these defaults can be used if not explicitly set
 */

interface FrameworkDefaults {
  workingDir: string;
  image: {
    production: string;
    development: string;
  };
}

/**
 * Mapping of framework names to their default configurations
 */
const FRAMEWORK_DEFAULTS: Record<string, FrameworkDefaults> = {
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
 * Get default configuration for a framework
 * @param framework - The framework name
 * @returns Framework defaults or undefined if framework is not recognized
 */
export function getFrameworkDefaults(
  framework: string,
): FrameworkDefaults | undefined {
  return FRAMEWORK_DEFAULTS[framework];
}

/**
 * Check if a framework is supported (has default configuration)
 * @param framework - The framework name
 * @returns True if framework is supported
 */
export function isFrameworkSupported(framework: string): boolean {
  return framework in FRAMEWORK_DEFAULTS;
}

/**
 * Get the list of supported frameworks
 * @returns Array of supported framework names
 */
export function getSupportedFrameworks(): string[] {
  return Object.keys(FRAMEWORK_DEFAULTS);
}

/**
 * Get the default image for a framework based on the current environment
 * @param framework - The framework name
 * @returns Default image string or undefined if framework is not recognized
 */
export function getDefaultImage(framework: string): string | undefined {
  const defaults = FRAMEWORK_DEFAULTS[framework];
  if (!defaults) return undefined;

  // Use dev image only when NODE_ENV is explicitly "development" or "test"
  // All other cases (production, undefined, etc.) use production image
  const isDevelopment =
    process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
  return isDevelopment ? defaults.image.development : defaults.image.production;
}

/**
 * Image variants for apps
 * Maps framework + apps combination to the appropriate image
 */
const FRAMEWORK_APPS_IMAGES: Record<
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
 * Get the default image for a framework with optional apps
 * @param framework - The framework name
 * @param apps - Optional array of apps in format "app" or "app:tag"
 * @returns Default image string or undefined if framework is not recognized
 */
export function getDefaultImageWithApps(
  framework: string,
  apps?: string[],
): string | undefined {
  const defaults = FRAMEWORK_DEFAULTS[framework];
  if (!defaults) return undefined;

  // Check if apps require a special image variant
  if (apps && apps.length > 0) {
    const frameworkApps = FRAMEWORK_APPS_IMAGES[framework];
    if (frameworkApps) {
      // Currently we only support single app (github)
      // For future: could combine apps or use most specific variant
      const firstApp = apps[0];
      if (firstApp) {
        const { app, tag } = parseAppString(firstApp);
        const appImage = frameworkApps[app];
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
