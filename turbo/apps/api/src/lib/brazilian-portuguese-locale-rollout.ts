import { optionalEnv } from "./env";

/**
 * Keep the writer disabled until old API readers have drained. Remove this
 * gate only after every rollback-eligible API version accepts stored pt-BR
 * locale preferences.
 */
export function isBrazilianPortugueseLocaleRolloutEnabled(): boolean {
  return optionalEnv("BRAZILIAN_PORTUGUESE_LOCALE_ROLLOUT_ENABLED") === "true";
}
