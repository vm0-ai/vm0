import { apiBackendUrl } from "./api-backend-url";
import { env } from "./env";
import { webUrl } from "./web-url";

/**
 * Base origin for API-originated internal self-dispatch callback URLs
 * (`/api/internal/**`).
 *
 * Resolves to the configured API backend origin. When unset,
 * production defaults to the known API backend origin so internal callbacks
 * never hop through the marketing surface at www.vm0.ai; other environments
 * fall back to the configured web URL, keeping local tunnels and tests usable.
 *
 * Use this only for internal self-dispatch URLs. User-provided / external
 * callbacks must not be routed through it.
 */
export function internalApiBaseUrl(): string {
  const backendUrl = apiBackendUrl();
  if (backendUrl) {
    return backendUrl;
  }
  if (env("ENV") === "production") {
    return "https://vm0-api.vm6.ai";
  }
  return webUrl();
}
