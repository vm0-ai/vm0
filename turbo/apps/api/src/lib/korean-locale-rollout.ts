import { optionalEnv } from "./env";

/**
 * Keep a deploy-time compatibility gate so emergency rollbacks can disable
 * ko-KR preference reads and writes without rebuilding the API.
 */
export function isKoreanLocaleRolloutEnabled(): boolean {
  return optionalEnv("KOREAN_LOCALE_ROLLOUT_ENABLED") === "true";
}
