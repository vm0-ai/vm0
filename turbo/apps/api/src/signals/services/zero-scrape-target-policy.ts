import { isIP } from "node:net";

import {
  fetchHostHasBlockedAddress,
  resolveFetchHostAddresses,
} from "../../lib/blocked-fetch-host";
import { safeUrlParse, tapError } from "../utils";

interface ScrapeTargetPolicyResult {
  readonly url: URL;
}

interface ScrapeTargetIpLiteral {
  readonly address: string;
  readonly family: 4 | 6;
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

function scrapeTargetIpLiteral(hostname: string): ScrapeTargetIpLiteral | null {
  const address =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  const family = isIP(address);
  if (family === 0) {
    return null;
  }
  return { address, family: family === 6 ? 6 : 4 };
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

  const ipLiteral = scrapeTargetIpLiteral(url.hostname);
  if (ipLiteral) {
    return fetchHostHasBlockedAddress([ipLiteral])
      ? "blocked_address"
      : { url };
  }

  if (hostnameIsInternal(url.hostname)) {
    return "internal_hostname";
  }

  const addresses = await tapError(resolveFetchHostAddresses(url.hostname));
  if (!addresses) {
    return "unresolvable_hostname";
  }
  if (fetchHostHasBlockedAddress(addresses)) {
    return "blocked_address";
  }

  return { url };
}
