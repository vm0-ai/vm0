/**
 * Resolves the Platform URL.
 *
 * - SaaS mode: replaces "www" with "platform" in the hostname
 *   (e.g. https://www.vm0.ai -> https://platform.vm0.ai)
 * - Self-hosted server-side: returns the absolute PLATFORM_URL
 *   (e.g. http://localhost:3001) for contexts that need a full URL
 * - Self-hosted client-side: returns "/platform" which Caddy redirects
 *   to the real platform port
 */
export function getPlatformUrl(): string {
  if (process.env.SELF_HOSTED === "true") {
    if (typeof window === "undefined") {
      return (
        process.env.PLATFORM_URL ||
        `http://localhost:${process.env.PLATFORM_PORT || "3001"}`
      );
    }
    return "/platform";
  }

  if (typeof window === "undefined") {
    // Server-side: use Caddy proxy in dev, production URL otherwise
    if (process.env.NODE_ENV === "development") {
      return "https://platform.vm7.ai:8443";
    }
    return "https://platform.vm0.ai";
  }

  const currentOrigin = window.location.origin;
  const url = new URL(currentOrigin);
  url.hostname = url.hostname.replace("www", "platform");
  return url.origin;
}
