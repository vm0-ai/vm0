import { computed } from "ccstate";
import { resolveApiBase, resolveOAuthApiBase } from "./api-base.ts";

/**
 * OAuth navigation uses the direct API in preview/development so those
 * environments do not depend on a WWW proxy. Production keeps the canonical
 * WWW route registered with providers.
 */
export const oauthBaseForNavigation$ = computed(() => {
  return resolveOAuthApiBase();
});

/**
 * Resolves the API base URL.
 * Derives the API URL from the current browser origin by preserving the root
 * domain and replacing the service subdomain segment ("platform", "app", or
 * "www") with "api".
 */
export const apiBase$ = computed(() => {
  return resolveApiBase();
});
