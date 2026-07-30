import { optionalEnv } from "./env";

/**
 * Keep a deploy-time compatibility gate so emergency rollbacks can disable
 * ja-JP preference reads and writes without rebuilding the API.
 */
export function isJapaneseLocaleRolloutEnabled(): boolean {
  return optionalEnv("JAPANESE_LOCALE_ROLLOUT_ENABLED") === "true";
}
