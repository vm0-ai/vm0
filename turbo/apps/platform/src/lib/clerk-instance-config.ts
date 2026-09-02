import {
  CURRENT_CLERK_PRODUCTION_PRIMARY_APP_DOMAIN,
  resolveClerkProductionSatelliteDomain,
  type ClerkProductionDomain,
  type ClerkProductionPrimaryAppDomain,
} from "./clerk-production-topology.ts";
import { resolvePlatformRuntimeConfig } from "./platform-host.ts";

export interface ClerkSatelliteConfig {
  readonly domain: ClerkProductionDomain;
  readonly isSatellite: true;
  readonly satelliteAutoSync: true;
}

export interface ClerkInstanceConfig {
  readonly publishableKey: string;
  readonly satelliteConfig: ClerkSatelliteConfig | null;
}

export function resolveConfiguredProductionPrimaryAppDomain(): ClerkProductionPrimaryAppDomain {
  const bootstrap = Reflect.get(globalThis, "__vm0ClerkBootstrap");
  if (
    typeof bootstrap === "object" &&
    bootstrap !== null &&
    "productionPrimaryAppDomain" in bootstrap &&
    bootstrap.productionPrimaryAppDomain === "app.okou.ai"
  ) {
    return bootstrap.productionPrimaryAppDomain;
  }
  return CURRENT_CLERK_PRODUCTION_PRIMARY_APP_DOMAIN;
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
