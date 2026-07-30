import { optionalEnv } from "./env";

/**
 * Keep a deploy-time compatibility gate so emergency rollbacks can disable
 * pt-BR preference reads and writes without rebuilding the API.
 */
export function isBrazilianPortugueseLocaleRolloutEnabled(): boolean {
  return optionalEnv("BRAZILIAN_PORTUGUESE_LOCALE_ROLLOUT_ENABLED") === "true";
}
