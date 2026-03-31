import { getApiUrl } from "../../../lib/api/config";

/**
 * Transform the API host to the platform (app) host.
 *
 *   www.vm0.ai                    → app.vm0.ai
 *   platform.vm0.ai               → app.vm0.ai
 *   tunnel-user-host-www.vm7.ai   → tunnel-user-host-app.vm7.ai
 *   custom.example.com            → app.custom.example.com
 */
export function toPlatformUrl(apiUrl: string): URL {
  const parsed = new URL(apiUrl);
  const parts = parsed.hostname.split(".");
  if (parts[0]!.endsWith("-www")) {
    parts[0] = parts[0]!.slice(0, -"-www".length) + "-app";
  } else if (parts[0] === "www" || parts[0] === "platform") {
    parts[0] = "app";
  } else if (parts[0] !== "app" && parts[0] !== "localhost") {
    parts.unshift("app");
  }
  parsed.hostname = parts.join(".");
  return parsed;
}

export async function getPlatformOrigin(): Promise<string> {
  const apiUrl = await getApiUrl();
  return toPlatformUrl(apiUrl).origin;
}
