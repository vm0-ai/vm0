/**
 * Framework utilities
 *
 * Defines supported agent frameworks and validation functions.
 */

/**
 * Supported framework identifiers
 */
export const SUPPORTED_FRAMEWORKS = ["claude-code", "codex"] as const;

export type SupportedFramework = (typeof SUPPORTED_FRAMEWORKS)[number];

/**
 * Check if a framework is supported
 */
export function isSupportedFramework(
  framework: string | undefined,
): framework is SupportedFramework {
  if (!framework) return false;
  return SUPPORTED_FRAMEWORKS.includes(framework as SupportedFramework);
}

/**
 * Assert that a framework is supported, throwing an error if not
 *
 * @param framework - The framework to validate
 * @param context - Optional context for the error message (e.g., function name)
 * @throws Error if framework is not supported
 */
export function assertSupportedFramework(
  framework: string | undefined,
  context?: string,
): asserts framework is SupportedFramework {
  if (!isSupportedFramework(framework)) {
    const contextMsg = context ? ` in ${context}` : "";
    throw new Error(
      `Unsupported framework "${framework}"${contextMsg}. Supported frameworks: ${SUPPORTED_FRAMEWORKS.join(", ")}`,
    );
  }
}

/**
 * Get a validated framework, defaulting to claude-code if undefined
 *
 * Use this for functions where undefined framework should default to claude-code.
 * Throws an error for unknown frameworks.
 *
 * @param framework - The framework to validate (undefined defaults to claude-code)
 * @returns The validated framework
 * @throws Error if framework is defined but not supported
 */
export function getValidatedFramework(
  framework: string | undefined,
): SupportedFramework {
  if (framework === undefined) {
    return "claude-code";
  }
  assertSupportedFramework(framework);
  return framework;
}

/**
 * Framework display names for UI
 */
const FRAMEWORK_DISPLAY_NAMES: Record<SupportedFramework, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

/**
 * Get the display name for a framework
 *
 * @param framework - The framework identifier
 * @returns The human-readable display name
 * @throws Error if framework is not supported
 */
export function getFrameworkDisplayName(framework: string): string {
  assertSupportedFramework(framework);
  return FRAMEWORK_DISPLAY_NAMES[framework];
}

/**
 * Canonical instructions filename for each framework.
 */
const FRAMEWORK_INSTRUCTIONS_FILENAMES: Record<SupportedFramework, string> = {
  "claude-code": "CLAUDE.md",
  codex: "AGENTS.md",
};

/**
 * Get the canonical instructions filename for a framework
 *
 * Each framework expects instructions at a specific filename:
 * - claude-code: CLAUDE.md (read from ~/.claude/)
 * - codex: AGENTS.md (read from ~/.codex/)
 *
 * Used by CLI (upload) and web API (read) to ensure a symmetric contract.
 *
 * @param framework - The framework name (undefined defaults to claude-code)
 * @returns The canonical filename for instructions
 * @throws Error if framework is defined but not supported
 */
export function getInstructionsFilename(framework?: string): string {
  const validated = getValidatedFramework(framework);
  return FRAMEWORK_INSTRUCTIONS_FILENAMES[validated];
}
