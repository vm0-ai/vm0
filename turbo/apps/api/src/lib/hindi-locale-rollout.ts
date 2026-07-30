import { optionalEnv } from "./env";

/**
 * Keep a deploy-time compatibility gate so emergency rollbacks can disable
 * hi-IN preference reads and writes without rebuilding the API.
 */
export function isHindiLocaleRolloutEnabled(): boolean {
  return optionalEnv("HINDI_LOCALE_ROLLOUT_ENABLED") === "true";
}
