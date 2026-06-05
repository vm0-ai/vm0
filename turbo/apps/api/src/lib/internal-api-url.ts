import { env } from "./env";

/**
 * Base origin for API-originated internal self-dispatch callback URLs
 * (`/api/internal/**`).
 *
 * Resolves to VM0_INTERNAL_API_URL when set, otherwise falls back to
 * VM0_API_URL. In production VM0_API_URL is `https://www.vm0.ai`, which routes
 * internal callbacks back through the web rewrite layer; setting
 * VM0_INTERNAL_API_URL to the direct API backend origin removes that www
 * self-call hop. When unset (dev/test/CI) the fallback keeps behavior
 * unchanged, so the dev-tunnel rewrite in the callback dispatcher still applies.
 *
 * Use this only for internal self-dispatch URLs. User-provided / external
 * callbacks and non-callback uses of VM0_API_URL must not be routed through it.
 */
export function internalApiBaseUrl(): string {
  return env("VM0_INTERNAL_API_URL") ?? env("VM0_API_URL");
}
