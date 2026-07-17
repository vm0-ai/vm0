import {
  resolvePlatformOriginForTarget,
  rewritePlatformHostname,
} from "../api-base.ts";
import {
  getOrCreateCardSignals,
  registeredCardSignals,
} from "./card-signal-map.ts";

export interface ComputerUseAuthorizationDescriptor {
  requestToken: string;
  originalUrl: string;
  href: string;
}

export type ComputerUseAuthorizationSignals =
  ComputerUseAuthorizationDescriptor;

export interface ComputerUseAuthorizationCardSignalsRegistry {
  register(
    descriptor: ComputerUseAuthorizationDescriptor,
  ): ComputerUseAuthorizationSignals;
  resolve(resourceKey: string): ComputerUseAuthorizationSignals;
}

function browserOrigin(): string | null {
  if (typeof location === "undefined" || !location.origin) {
    return null;
  }
  return location.origin;
}

function addAllowedOriginVariants(
  origins: Set<string>,
  baseUrl: string | null,
) {
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

function isPlatformHostname(hostname: string): boolean {
  const isPlatformDomain = ["vm0.ai", "vm6.ai", "vm7.ai"].some((suffix) => {
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  });
  if (!isPlatformDomain) {
    return false;
  }

  return /(^|-)(platform|app|www|api)\./.test(hostname);
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
    isPlatformHostname(url.hostname)
  );
}

export function parseComputerUseAuthorizationUrl(
  value: string,
): ComputerUseAuthorizationDescriptor | null {
  const url = parseUrl(value);
  if (!url || !isAllowedUrl(url, value)) {
    return null;
  }

  const match = url.pathname.match(/^\/computer-use\/authorize\/([^/]+)$/);
  const requestToken = match?.[1];
  if (!requestToken) {
    return null;
  }

  const href = `/computer-use/authorize/${encodeURIComponent(requestToken)}`;
  return {
    requestToken,
    originalUrl: value,
    href,
  };
}

export function createComputerUseAuthorizationSignals(
  descriptor: ComputerUseAuthorizationDescriptor,
): ComputerUseAuthorizationSignals {
  return descriptor;
}

export function createComputerUseAuthorizationCardSignalsRegistry(): ComputerUseAuthorizationCardSignalsRegistry {
  const signalsByResourceKey = new Map<
    string,
    ComputerUseAuthorizationSignals
  >();
  return {
    register(descriptor) {
      return getOrCreateCardSignals(
        signalsByResourceKey,
        descriptor.href,
        () => {
          return createComputerUseAuthorizationSignals(descriptor);
        },
      );
    },
    resolve(resourceKey) {
      return registeredCardSignals(signalsByResourceKey, resourceKey);
    },
  };
}
