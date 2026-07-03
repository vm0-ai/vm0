// This module must stay loadable by the bootstrap entry: keep it free of
// workspace (`@vm0/*`) and non-Electron package imports.

function replaceHostPrefix(hostname: string, target: string): string {
  return hostname.replace(/(^|-)(api|app|platform|www)\./, `$1${target}.`);
}

export function resolveComputerUseApiBaseUrl(platformUrl: URL): string {
  const url = new URL(platformUrl.toString());
  url.hostname = replaceHostPrefix(url.hostname, "api");
  return url.toString().replace(/\/$/, "");
}
