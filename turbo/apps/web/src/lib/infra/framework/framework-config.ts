/**
 * Server-side framework configuration
 *
 * Provides per-framework defaults: working directory, instructions mount
 * path, and the API-key environment variable name expected in the compose
 * environment block. Uses SUPPORTED_FRAMEWORKS from @vm0/core as the
 * source of truth.
 */

import type { SupportedFramework } from "@vm0/core/frameworks";

/**
 * Framework default configuration
 */
interface FrameworkDefaults {
  workingDir: string;
  instructionsMountPath: string;
  apiKeyEnvVar: string;
}

/**
 * Default configurations for each supported framework
 */
const FRAMEWORK_DEFAULTS: Record<SupportedFramework, FrameworkDefaults> = {
  "claude-code": {
    workingDir: "/home/user/workspace",
    instructionsMountPath: "/home/user/.claude",
    apiKeyEnvVar: "ANTHROPIC_API_KEY",
  },
  codex: {
    workingDir: "/home/user/workspace",
    instructionsMountPath: "/home/user/.codex",
    apiKeyEnvVar: "OPENAI_API_KEY",
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

/**
 * Resolve the instructions mount path for a framework
 *
 * @param framework - The supported framework
 * @returns The mount path where instructions volume is attached
 */
export function resolveFrameworkInstructionsMountPath(
  framework: SupportedFramework,
): string {
  return FRAMEWORK_DEFAULTS[framework].instructionsMountPath;
}

/**
 * Resolve the API-key environment variable name for a framework
 *
 * @param framework - The supported framework
 * @returns The env var name the compose environment block must declare
 */
export function resolveFrameworkApiKeyEnvVar(
  framework: SupportedFramework,
): string {
  return FRAMEWORK_DEFAULTS[framework].apiKeyEnvVar;
}

/**
 * Compose content shape used for framework extraction.
 *
 * Modern composes nest agents under `agents.<name>.framework`; the legacy
 * `agent.framework` shape is retained for older rows. Both forms appear in
 * `agentComposeVersions.content` (jsonb), so callers should accept either.
 */
interface ComposeContentLike {
  agent?: { framework?: string };
  agents?: Record<string, { framework?: string } | undefined>;
}

/**
 * Extract the framework string from a compose document.
 *
 * Tries the legacy `agent.framework` first, then falls back to the first
 * entry of `agents` (current resolved-content shape — composes carry exactly
 * one agent post-resolve). Returns `null` when no framework can be found,
 * leaving the caller to decide on a default.
 */
export function extractFrameworkFromCompose(
  content: ComposeContentLike | null | undefined,
): string | null {
  if (!content) {
    return null;
  }

  if (content.agent?.framework) {
    return content.agent.framework;
  }

  const agents = content.agents;
  if (agents) {
    const firstKey = Object.keys(agents)[0];
    if (firstKey) {
      return agents[firstKey]?.framework ?? null;
    }
  }

  return null;
}
