import { optionalEnv } from "./env";

/**
 * Keep a deploy-time compatibility gate so emergency rollbacks can disable
 * id-ID preference reads and writes without rebuilding the API.
 */
export function isIndonesianLocaleRolloutEnabled(): boolean {
  return optionalEnv("INDONESIAN_LOCALE_ROLLOUT_ENABLED") === "true";
}
