/**
 * E2B configuration
 */

export const e2bConfig = {
  defaultTimeout: 0, // No timeout - allows indefinite execution
  // Default template name for E2B sandbox with Claude Code CLI
  // Templates are built via CI and pushed to separate E2B accounts (dev/prod)
  // The same template name exists in both accounts, isolated by E2B_API_KEY
  defaultTemplate: "vm0-claude-code",
} as const;
