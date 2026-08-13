// This module must stay loadable by the bootstrap entry: keep it free of
// workspace (`@okouai/*`) and non-Electron package imports.

function replaceHostPrefix(hostname: string, target: "api" | "www"): string {
  return hostname.replace(/(^|-)(api|app|platform|www)\./, `$1${target}.`);
}

const CLOUDFLARE_PREVIEW_APP_HOSTNAME = /^(?:staging|pr-[0-9]+)-app\.omby\.ai$/;
const OKOU_PRODUCTION_APP_HOSTNAME = "app.okou.ai";
const VM0_PRODUCTION_SERVICE_HOSTNAMES = {
  api: "api.vm0.ai",
  www: "www.vm0.ai",
} as const;

export function rewriteDesktopServiceHostname(
  hostname: string,
  target: "api" | "www",
): string {
  if (hostname === OKOU_PRODUCTION_APP_HOSTNAME) {
    return VM0_PRODUCTION_SERVICE_HOSTNAMES[target];
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
