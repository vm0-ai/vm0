import {
  resolveClerkProductionSatelliteDomain,
  type ClerkProductionDomain,
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

export function resolveClerkSatelliteConfig(): ClerkSatelliteConfig | null {
  if (typeof location === "undefined") {
    return null;
  }
  const domain = resolveClerkProductionSatelliteDomain(location.hostname);
  return domain ? { domain, isSatellite: true, satelliteAutoSync: true } : null;
}

export function resolveClerkInstanceConfig(): ClerkInstanceConfig {
  return {
    publishableKey: resolvePlatformRuntimeConfig().clerkPublishableKey,
    satelliteConfig: resolveClerkSatelliteConfig(),
  };
}
