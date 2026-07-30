import { optionalEnv } from "./env";

/**
 * Keep the writer disabled until old API readers have drained. Remove this
 * gate only after every rollback-eligible API version accepts stored de-DE
 * locale preferences.
 */
export function isGermanLocaleRolloutEnabled(): boolean {
  return optionalEnv("GERMAN_LOCALE_ROLLOUT_ENABLED") === "true";
}
