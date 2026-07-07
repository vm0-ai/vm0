export type PlatformHostTarget = "api" | "www" | "app" | "platform";

const PLATFORM_SERVICE_LABELS = ["platform", "app", "www", "api"] as const;

function trimTrailingSlash(base: string): string {
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

export function rewritePlatformHostname(
  hostname: string,
  target: PlatformHostTarget,
): string {
  const labels = hostname.split(".");
  const serviceLabelIndex = labels.length - 3;
  if (serviceLabelIndex < 0) {
    return hostname;
  }

  const serviceLabel = labels[serviceLabelIndex];
  if (!serviceLabel) {
    return hostname;
  }

  if ((PLATFORM_SERVICE_LABELS as readonly string[]).includes(serviceLabel)) {
    labels[serviceLabelIndex] = target;
    return labels.join(".");
  }

  for (const label of PLATFORM_SERVICE_LABELS) {
    const suffix = `-${label}`;
    if (serviceLabel.endsWith(suffix)) {
      labels[serviceLabelIndex] =
        `${serviceLabel.slice(0, -label.length)}${target}`;
      return labels.join(".");
    }
  }

  return hostname;
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
  const url = new URL(origin);
  url.hostname = rewritePlatformHostname(url.hostname, target);
  return url.origin;
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
    throw new Error(
      "Cannot resolve platform API URL without a browser origin",
    );
  }
  return origin;
}

export function resolveApiBase(): string {
  return resolveApiBaseForTarget("api");
}

export function resolveApiBaseForNavigation(target: PlatformHostTarget): string {
  return resolveApiBaseForTarget(target);
}
