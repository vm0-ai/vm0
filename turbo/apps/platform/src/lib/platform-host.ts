export type PlatformEnvironment = "development" | "preview" | "production";

function browserHostname(): string | null {
  if (typeof location === "undefined" || !location.hostname) {
    return null;
  }
  return location.hostname.toLowerCase();
}

export function isProductionHostname(hostname: string): boolean {
  return hostname === "vm0.ai" || hostname.endsWith(".vm0.ai");
}

export function resolvePlatformEnvironment(): PlatformEnvironment {
  const hostname = browserHostname();
  if (!hostname) {
    return "preview";
  }

  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return "development";
  }

  return isProductionHostname(hostname) ? "production" : "preview";
}

export function resolvePublicArtifactsBaseUrl():
  | "https://cdn.vm0.io"
  | "https://cdn.vm7.io" {
  return resolvePlatformEnvironment() === "production"
    ? "https://cdn.vm0.io"
    : "https://cdn.vm7.io";
}

export function resolveZeroHostDomain(): "sites.vm0.io" | "sites.vm7.io" {
  return resolvePlatformEnvironment() === "production"
    ? "sites.vm0.io"
    : "sites.vm7.io";
}
