/**
 * Server-side framework configuration
 *
 * Provides working directory resolution based on framework.
 * Uses SUPPORTED_FRAMEWORKS from @vm0/core as the source of truth.
 */

import type { SupportedFramework } from "@vm0/core/frameworks";

/**
 * Framework default configuration
 */
interface FrameworkDefaults {
  workingDir: string;
}

/**
 * Default configurations for each supported framework
 */
const FRAMEWORK_DEFAULTS: Record<SupportedFramework, FrameworkDefaults> = {
  "claude-code": {
    workingDir: "/home/user/workspace",
  },
};

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
