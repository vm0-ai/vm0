function getConfiguredApiUrl(): string {
  const url = import.meta.env.VITE_API_URL as string | undefined;
  if (!url) {
    throw new Error("Missing VITE_API_URL environment variable");
  }
  return url;
}

const CONFIGURED_API_URL = getConfiguredApiUrl();

export type ApiHostTarget = "api" | "www";

function trimTrailingSlash(base: string): string {
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

function rewriteApiHostname(hostname: string, target: ApiHostTarget): string {
  return hostname.replace(/(^|-)(platform|app|www|api)\./, `$1${target}.`);
}

function configuredApiBase(target: ApiHostTarget): string {
  const url = new URL(CONFIGURED_API_URL);
  url.hostname = rewriteApiHostname(url.hostname, target);
  return url.origin;
}

function browserOrigin(): string | null {
  if (typeof location === "undefined" || !location.origin) {
    return null;
  }
  return location.origin;
}

function browserOriginBase(target: ApiHostTarget): string | null {
  const origin = browserOrigin();
  if (!origin) {
    return null;
  }
  const url = new URL(origin);
  url.hostname = rewriteApiHostname(url.hostname, target);
  return url.origin;
}

function isLocalhostBrowser(): boolean {
  return (
    typeof location !== "undefined" &&
    (location.hostname === "localhost" || location.hostname === "127.0.0.1")
  );
}

export function resolveApiBaseForTarget(target: ApiHostTarget): string {
  if (CONFIGURED_API_URL === "http://localhost:3000") {
    return browserOriginBase(target) ?? configuredApiBase(target);
  }
  return trimTrailingSlash(configuredApiBase(target));
}

export function resolveApiBase(useApiBackend: boolean): string {
  return resolveApiBaseForTarget(useApiBackend ? "api" : "www");
}

export function resolveApiBaseForNavigation(useApiBackend: boolean): string {
  const target = useApiBackend ? "api" : "www";
  if (isLocalhostBrowser()) {
    return configuredApiBase(target);
  }
  return browserOriginBase(target) ?? configuredApiBase(target);
}
