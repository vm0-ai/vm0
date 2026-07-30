import { optionalEnv } from "./env";

/**
 * Keep a deploy-time compatibility gate so emergency rollbacks can disable
 * it-IT preference reads and writes without rebuilding the API.
 */
export function isItalianLocaleRolloutEnabled(): boolean {
  return optionalEnv("ITALIAN_LOCALE_ROLLOUT_ENABLED") === "true";
}
