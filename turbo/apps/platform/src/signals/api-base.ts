import {
  derivePlatformServiceOrigin,
  type PlatformService,
} from "@okouai/core/platform-service-origin";

import { resolvePlatformEnvironment } from "../lib/platform-host.ts";

type PlatformHostTarget = PlatformService;

function trimTrailingSlash(base: string): string {
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

function browserOrigin(): string | null {
  if (typeof location === "undefined" || !location.origin) {
    return null;
  }
  return location.origin;
}

export function resolvePlatformOriginForTarget(
  target: PlatformHostTarget,
): string | null {
  const origin = browserOrigin();
  if (!origin) {
    return null;
  }

  return trimTrailingSlash(derivePlatformServiceOrigin(origin, target));
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
