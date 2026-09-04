import { rewritePlatformHostname } from "@okouai/core/platform-service-origin";

import { resolvePlatformOriginForTarget } from "../api-base.ts";

const PREVIEW_PLATFORM_DOMAINS = ["vm6.ai", "vm7.ai"] as const;
const PLATFORM_SERVICE_HOSTNAME_PATTERN = /(^|-)(platform|app|www|api)\./u;

function browserOrigin(): string | null {
  if (typeof location === "undefined" || !location.origin) {
    return null;
  }
  return location.origin;
}

function addAllowedOriginVariants(
  origins: Set<string>,
  baseUrl: string | null,
): void {
  if (!baseUrl || !URL.canParse(baseUrl)) {
    return;
  }

  const parsed = new URL(baseUrl);
  origins.add(parsed.origin);

  for (const target of ["api", "www", "app", "platform"] as const) {
    const variant = new URL(parsed);
    variant.hostname = rewritePlatformHostname(variant.hostname, target);
    origins.add(variant.origin);
  }
}

function allowedOrigins(): Set<string> {
  const origins = new Set<string>();
  addAllowedOriginVariants(origins, browserOrigin());
  addAllowedOriginVariants(origins, resolvePlatformOriginForTarget("api"));
  return origins;
}

function baseUrl(): string | null {
  return browserOrigin() ?? resolvePlatformOriginForTarget("api");
}

function stripUrlParserIgnoredPrefix(value: string): string {
  let index = 0;
  while (index < value.length && value.charCodeAt(index) <= 0x20) {
    index += 1;
  }
  return value.slice(index);
}

function hasExplicitUrlOrigin(value: string): boolean {
  return (
    URL.canParse(value) || stripUrlParserIgnoredPrefix(value).startsWith("//")
  );
}

function isDomainOrSubdomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function isTrustedPlatformHostname(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase();
  if (
    normalizedHostname === "app.vm0.ai" ||
    normalizedHostname === "app.okou.ai"
  ) {
    return true;
  }

  return PREVIEW_PLATFORM_DOMAINS.some((domain) => {
    return (
      isDomainOrSubdomain(normalizedHostname, domain) &&
      PLATFORM_SERVICE_HOSTNAME_PATTERN.test(normalizedHostname)
    );
  });
}

function isHttpUrl(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

function parseUrl(value: string): URL | null {
  const configuredBaseUrl = baseUrl();
  if (configuredBaseUrl) {
    if (!URL.canParse(value, configuredBaseUrl)) {
      return null;
    }
    return new URL(value, configuredBaseUrl);
  }

  if (!URL.canParse(value)) {
    return null;
  }
  return new URL(value);
}

function isAllowedUrl(url: URL, sourceUrl: string): boolean {
  const explicitOrigin = hasExplicitUrlOrigin(sourceUrl);
  if (explicitOrigin && !isHttpUrl(url)) {
    return false;
  }

  return (
    !explicitOrigin ||
    allowedOrigins().has(url.origin) ||
    isTrustedPlatformHostname(url.hostname)
  );
}

export function parseTrustedPlatformUrl(value: string): URL | null {
  const url = parseUrl(value);
  return url && isAllowedUrl(url, value) ? url : null;
}
