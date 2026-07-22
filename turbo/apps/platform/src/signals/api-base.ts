import {
  derivePlatformServiceOrigin,
  resolvePlatformEnvironment,
  rewritePlatformHostname,
  type PlatformService,
} from "../lib/platform-host.ts";

export type PlatformHostTarget = PlatformService;
export { rewritePlatformHostname };

function trimTrailingSlash(base: string): string {
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

function browserOrigin(): string | null {
  if (typeof location === "undefined" || !location.origin) {
    return null;
  }
  return location.origin;
}

function platformOriginForTarget(
  origin: string,
  target: PlatformHostTarget,
): string {
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
