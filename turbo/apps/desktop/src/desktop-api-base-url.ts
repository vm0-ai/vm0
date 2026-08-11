// This module must stay loadable by the bootstrap entry: keep it free of
// workspace (`@vm0/*`) and non-Electron package imports.

import desktopDomains from "./desktop-domains.json";

const PRODUCTION_PLATFORM_HOSTNAMES = new Set(
  desktopDomains.compatiblePlatformUrls.map((url) => new URL(url).hostname),
);

export function isProductionDesktopPlatformHostname(hostname: string): boolean {
  return PRODUCTION_PLATFORM_HOSTNAMES.has(hostname);
}

function replaceHostPrefix(hostname: string, target: "api" | "www"): string {
  return hostname.replace(/(^|-)(api|app|platform|www)\./, `$1${target}.`);
}

const CLOUDFLARE_PREVIEW_APP_HOSTNAME = /^(?:staging|pr-[0-9]+)-app\.omby\.ai$/;

export function rewriteDesktopServiceHostname(
  hostname: string,
  target: "api" | "www",
): string {
  if (isProductionDesktopPlatformHostname(hostname)) {
    return new URL(desktopDomains.productionServiceUrls[target]).hostname;
  }

  const rewrittenHostname = replaceHostPrefix(hostname, target);
  if (target !== "api" || !CLOUDFLARE_PREVIEW_APP_HOSTNAME.test(hostname)) {
    return rewrittenHostname;
  }
  return rewrittenHostname.replace(/\.omby\.ai$/, ".vm6.ai");
}

export function resolveComputerUseApiBaseUrl(platformUrl: URL): string {
  const url = new URL(platformUrl.toString());
  url.hostname = rewriteDesktopServiceHostname(url.hostname, "api");
  return url.toString().replace(/\/$/, "");
}
