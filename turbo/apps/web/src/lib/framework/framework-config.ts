/**
 * Server-side framework configuration
 *
 * Provides image and working directory resolution based on framework.
 * Uses SUPPORTED_FRAMEWORKS from @vm0/core as the source of truth.
 */

import type { SupportedFramework } from "@vm0/core";

/**
 * Framework default configuration
 */
interface FrameworkDefaults {
  workingDir: string;
  image: {
    production: string;
    development: string;
  };
}

/**
 * Default configurations for each supported framework
 */
const FRAMEWORK_DEFAULTS: Record<SupportedFramework, FrameworkDefaults> = {
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
 * App-aware image variants
 * Maps framework + app combination to specialized images
 */
const FRAMEWORK_APPS_IMAGES: Record<
  SupportedFramework,
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
 * Resolve the image for a framework based on apps configuration
 *
 * @param framework - The supported framework
 * @param apps - Optional array of apps in format "app" or "app:tag"
 * @returns The resolved image string
 */
export function resolveFrameworkImage(
  framework: SupportedFramework,
  apps?: string[],
): string {
  const defaults = FRAMEWORK_DEFAULTS[framework];

  // Check if apps require a special image variant
  if (apps && apps.length > 0) {
    const frameworkApps = FRAMEWORK_APPS_IMAGES[framework];
    // Currently we only support single app (github)
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

  // Fall back to default image based on VERCEL_ENV
  // In production, use :latest; otherwise use :dev
  const isProduction = process.env.VERCEL_ENV === "production";
  return isProduction ? defaults.image.production : defaults.image.development;
}

/**
 * Resolve the working directory for a framework
 *
 * @param framework - The supported framework
 * @returns The working directory path
 */
export function resolveFrameworkWorkingDir(
  framework: SupportedFramework,
): string {
  return FRAMEWORK_DEFAULTS[framework].workingDir;
}
