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
 * Resolve the image for a framework
 *
 * @param framework - The supported framework
 * @returns The resolved image string (always uses :latest tag)
 */
export function resolveFrameworkImage(framework: SupportedFramework): string {
  return FRAMEWORK_DEFAULTS[framework].image;
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
