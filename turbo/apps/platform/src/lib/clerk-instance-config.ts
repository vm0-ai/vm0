import {
  normalizeClerkProductionPrimaryAppDomain,
  resolveClerkProductionSatelliteDomain,
  type ClerkProductionDomain,
  type ClerkProductionPrimaryAppDomain,
} from "./clerk-production-topology.ts";
import { resolvePlatformRuntimeConfig } from "./platform-host.ts";

interface ClerkSatelliteConfig {
  readonly domain: ClerkProductionDomain;
  readonly isSatellite: true;
  readonly satelliteAutoSync: true;
}

interface ClerkInstanceConfig {
  readonly publishableKey: string;
  readonly satelliteConfig: ClerkSatelliteConfig | null;
}

export function resolveConfiguredProductionPrimaryAppDomain(): ClerkProductionPrimaryAppDomain {
  const bootstrap = Reflect.get(globalThis, "__vm0ClerkBootstrap");
  const configured =
    typeof bootstrap === "object" &&
    bootstrap !== null &&
    "productionPrimaryAppDomain" in bootstrap
      ? bootstrap.productionPrimaryAppDomain
      : undefined;
  // A missing bootstrap object is the same unknown input as a missing
  // injected value, so both fail closed to the deployed topology.
  return normalizeClerkProductionPrimaryAppDomain(configured);
}

export function resolveClerkSatelliteConfig(): ClerkSatelliteConfig | null {
  if (typeof location === "undefined") {
    return null;
  }
  const domain = resolveClerkProductionSatelliteDomain(
    location.hostname,
    resolveConfiguredProductionPrimaryAppDomain(),
  );
  return domain ? { domain, isSatellite: true, satelliteAutoSync: true } : null;
}

export function resolveClerkInstanceConfig(): ClerkInstanceConfig {
  return {
    publishableKey: resolvePlatformRuntimeConfig().clerkPublishableKey,
    satelliteConfig: resolveClerkSatelliteConfig(),
  };
}
