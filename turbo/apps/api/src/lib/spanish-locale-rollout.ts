import { optionalEnv } from "./env";

/**
 * Keep the writer disabled until old API readers have drained. Remove this
 * gate only after every rollback-eligible API version accepts stored es-ES
 * locale preferences.
 */
export function isSpanishLocaleRolloutEnabled(): boolean {
  return optionalEnv("SPANISH_LOCALE_ROLLOUT_ENABLED") === "true";
}
