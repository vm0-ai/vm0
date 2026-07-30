import { optionalEnv } from "./env";

/**
 * Keep the writer disabled until old API readers have drained. The gate also
 * lets deployments stop advertising and accepting fr-FR during rollback.
 */
export function isFrenchLocaleRolloutEnabled(): boolean {
  return optionalEnv("FRENCH_LOCALE_ROLLOUT_ENABLED") === "true";
}
