import {
  derivePlatformServiceOrigin,
  resolvePlatformEnvironment,
  rewritePlatformHostname,
  type PlatformService,
} from "../lib/platform-host.ts";

type PlatformHostTarget = PlatformService;
export { rewritePlatformHostname };

const OKOU_PAGES_PREVIEW_HOST_SUFFIX = ".okou-app.pages.dev";
const PREVIEW_API_HOSTNAME_PATTERN = /^(?:staging|pr-[0-9]+)-api\.vm6\.ai$/u;
const PREVIEW_API_ORIGIN_SELECTOR = 'meta[name="vm0-api-origin"]';

function trimTrailingSlash(base: string): string {
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

function browserOrigin(): string | null {
  if (typeof location === "undefined" || !location.origin) {
    return null;
  }
  return location.origin;
}

function configuredPreviewApiOrigin(currentOrigin: string): string | null {
  const currentUrl = new URL(currentOrigin);
  if (
    currentUrl.protocol !== "https:" ||
    !currentUrl.hostname.endsWith(OKOU_PAGES_PREVIEW_HOST_SUFFIX) ||
    typeof document === "undefined"
  ) {
    return null;
  }

  const element = document.querySelector(PREVIEW_API_ORIGIN_SELECTOR);
  if (!(element instanceof HTMLMetaElement)) {
    return null;
  }

  const configuredOrigin = element.content.trim();
  if (!configuredOrigin) {
    return null;
  }

  const configuredUrl = new URL(configuredOrigin);
  if (
    configuredUrl.protocol !== "https:" ||
    configuredUrl.port !== "" ||
    configuredUrl.username !== "" ||
    configuredUrl.password !== "" ||
    configuredUrl.pathname !== "/" ||
    configuredUrl.search !== "" ||
    configuredUrl.hash !== "" ||
    !PREVIEW_API_HOSTNAME_PATTERN.test(configuredUrl.hostname)
  ) {
    throw new Error("Invalid Cloudflare Pages preview API origin");
  }

  return configuredUrl.origin;
}

function platformOriginForTarget(
  origin: string,
  target: PlatformHostTarget,
): string {
  if (target === "api") {
    const configuredOrigin = configuredPreviewApiOrigin(origin);
    if (configuredOrigin) {
      return configuredOrigin;
    }
  }
  return derivePlatformServiceOrigin(origin, target);
}

export function resolvePlatformOriginForTarget(
  target: PlatformHostTarget,
): string | null {
  const origin = browserOrigin();
  if (!origin) {
    return null;
  }

  return trimTrailingSlash(platformOriginForTarget(origin, target));
}

export function resolveApiBaseForTarget(target: PlatformHostTarget): string {
  const origin = resolvePlatformOriginForTarget(target);
  if (!origin) {
    throw new Error("Cannot resolve platform API URL without a browser origin");
  }
  return origin;
}

export function resolveApiBase(): string {
  return resolveApiBaseForTarget("api");
}

export function resolveOAuthApiBase(): string {
  return resolveApiBaseForTarget(
    resolvePlatformEnvironment() === "production" ? "www" : "api",
  );
}

export function resolveApiBaseForNavigation(
  target: PlatformHostTarget,
): string {
  return resolveApiBaseForTarget(target);
}
