import { isIP } from "node:net";

import {
  fetchHostHasBlockedAddress,
  resolveFetchHostAddresses,
} from "../../lib/blocked-fetch-host";
import { safeAsync, safeUrlParse } from "../utils";

interface ScrapeTargetPolicyResult {
  readonly url: URL;
}

export type ScrapeTargetPolicyError =
  | "invalid_url"
  | "unsupported_scheme"
  | "embedded_credentials"
  | "internal_hostname"
  | "unresolvable_hostname"
  | "blocked_address";

function hostnameIsInternal(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (!normalized) {
    return true;
  }
  if (
    normalized === "localhost" ||
    normalized === "localhost.localdomain" ||
    normalized.endsWith(".localhost")
  ) {
    return true;
  }
  if (normalized.endsWith(".local")) {
    return true;
  }
  return isIP(normalized) === 0 && !normalized.includes(".");
}

export async function validateScrapeTargetUrl(
  rawUrl: string,
): Promise<ScrapeTargetPolicyResult | ScrapeTargetPolicyError> {
  const url = safeUrlParse(rawUrl);
  if (!url) {
    return "invalid_url";
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "unsupported_scheme";
  }

  if (url.username || url.password) {
    return "embedded_credentials";
  }

  if (hostnameIsInternal(url.hostname)) {
    return "internal_hostname";
  }

  const result = await safeAsync(async () => {
    return await resolveFetchHostAddresses(url.hostname);
  });
  if ("error" in result) {
    return "unresolvable_hostname";
  }
  if (fetchHostHasBlockedAddress(result.ok)) {
    return "blocked_address";
  }

  return { url };
}
