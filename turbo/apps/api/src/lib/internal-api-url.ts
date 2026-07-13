import { env } from "./env";

/**
 * Base origin for API-originated internal self-dispatch callback URLs
 * (`/api/internal/**`).
 *
 * Resolves to VM0_API_BACKEND_URL, the direct API backend origin. When unset,
 * production defaults to the known API backend origin so internal callbacks
 * never hop through the marketing surface at www.vm0.ai; other environments
 * fall back to VM0_WEB_URL, keeping local tunnels and tests usable.
 *
 * Use this only for internal self-dispatch URLs. User-provided / external
 * callbacks must not be routed through it.
 */
export function internalApiBaseUrl(): string {
  const backendUrl = env("VM0_API_BACKEND_URL");
  if (backendUrl) {
    return backendUrl;
  }
  if (env("ENV") === "production") {
    return "https://vm0-api.vm6.ai";
  }
  return env("VM0_WEB_URL");
}
