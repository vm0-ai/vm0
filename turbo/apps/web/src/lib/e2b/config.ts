/**
 * E2B sandbox configuration for compose jobs
 *
 * Templates are built via CI and pushed to separate E2B accounts:
 * - Development: Uses repository-level E2B_API_KEY secret
 * - Production: Uses production environment E2B_API_KEY secret
 *
 * The same template names exist in both accounts, isolated by the API key.
 */
export const e2bConfig = {
  /** Sandbox timeout in ms. 0 = no timeout (indefinite execution) */
  defaultTimeout: 0,
  /** E2B template with vm0 CLI pre-installed for compose jobs */
  cliTemplate: "vm0-cli",
} as const;
