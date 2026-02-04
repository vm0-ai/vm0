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
  image: string;
}

/**
 * Default configurations for each supported framework
 * Note: All images use :latest tag. The :dev tag is no longer supported.
 */
const FRAMEWORK_DEFAULTS: Record<SupportedFramework, FrameworkDefaults> = {
  "claude-code": {
    workingDir: "/home/user/workspace",
    image: "vm0/claude-code:latest",
  },
  codex: {
    workingDir: "/home/user/workspace",
    image: "vm0/codex:latest",
  },
};

/**
 * App-aware image variants
 * Maps framework + app combination to specialized images
 * Note: All images use :latest tag. The :dev tag is no longer supported.
 */
const FRAMEWORK_APPS_IMAGES: Record<
  SupportedFramework,
  Record<string, string>
> = {
  "claude-code": {
    github: "vm0/claude-code-github:latest",
  },
  codex: {
    github: "vm0/codex-github:latest",
  },
};

/**
 * Parse app string into app name (tag is ignored, always uses :latest)
 * @param appString - App string in format "app" or "app:tag"
 * @returns The app name
 */
function parseAppName(appString: string): string {
  const [app] = appString.split(":");
  return app ?? appString;
}

/**
 * Resolve the image for a framework based on apps configuration
 *
 * @param framework - The supported framework
 * @param apps - Optional array of apps in format "app" or "app:tag" (tag is ignored)
 * @returns The resolved image string (always uses :latest tag)
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
      const appName = parseAppName(firstApp);
      const appImage = frameworkApps[appName];
      if (appImage) {
        return appImage;
      }
    }
  }

  return defaults.image;
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
