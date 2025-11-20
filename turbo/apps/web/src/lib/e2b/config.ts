import { env } from "../../env";

/**
 * E2B configuration
 */

export const e2bConfig = {
  defaultTimeout: 0, // No timeout - allows indefinite execution
  // Template name for E2B sandbox with Claude Code CLI
  // See E2B_SETUP.md for instructions on building and pushing the template
  // Leave undefined to use default E2B image (Claude Code must be installed manually)
  defaultTemplate: env().E2B_TEMPLATE_NAME, // Optional: Custom template name (alias)
} as const;
