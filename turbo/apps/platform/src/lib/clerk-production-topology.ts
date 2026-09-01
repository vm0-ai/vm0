export const OKOU_CLERK_PRIMARY_APP_ORIGIN = "https://app.okou.ai";
export const VM0_CLERK_PRIMARY_APP_ORIGIN = "https://app.vm0.ai";

export const CURRENT_CLERK_PRODUCTION_SATELLITE_DOMAIN = "app.okou.ai";
export const CUTOVER_CLERK_PRODUCTION_SATELLITE_DOMAIN = "vm0.ai";
const CLERK_PRIMARY_USER_PROFILE_URL = "https://accounts.vm0.ai/user";

export type ClerkProductionDomain = "app.okou.ai" | "vm0.ai";

interface ClerkProductionTopology {
  readonly primaryAppOrigin:
    | typeof OKOU_CLERK_PRIMARY_APP_ORIGIN
    | typeof VM0_CLERK_PRIMARY_APP_ORIGIN;
  readonly primaryUserProfileUrl: typeof CLERK_PRIMARY_USER_PROFILE_URL;
  readonly primaryBrand: "okou" | "vm0";
}

function isDomainOrSubdomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function normalizeClerkProductionSatelliteDomain(
  value: unknown,
): ClerkProductionDomain {
  return value === CUTOVER_CLERK_PRODUCTION_SATELLITE_DOMAIN
    ? CUTOVER_CLERK_PRODUCTION_SATELLITE_DOMAIN
    : CURRENT_CLERK_PRODUCTION_SATELLITE_DOMAIN;
}

// The Clerk instance and publishable key remain on clerk.vm0.ai. The explicit
// satellite-domain deployment value is the source of truth for which app owns
// primary auth. Unknown values fail closed to the currently deployed topology.
export function resolveClerkProductionTopology(
  satelliteDomain: unknown,
): ClerkProductionTopology {
  if (
    normalizeClerkProductionSatelliteDomain(satelliteDomain) ===
    CUTOVER_CLERK_PRODUCTION_SATELLITE_DOMAIN
  ) {
    return {
      primaryAppOrigin: OKOU_CLERK_PRIMARY_APP_ORIGIN,
      primaryBrand: "okou",
      primaryUserProfileUrl: CLERK_PRIMARY_USER_PROFILE_URL,
    };
  }

  return {
    primaryAppOrigin: VM0_CLERK_PRIMARY_APP_ORIGIN,
    primaryBrand: "vm0",
    primaryUserProfileUrl: CLERK_PRIMARY_USER_PROFILE_URL,
  };
}

export function resolveClerkProductionSatelliteDomain(
  hostname: string,
  satelliteDomain: unknown,
): ClerkProductionDomain | null {
  const normalizedHostname = hostname.toLowerCase();
  const normalizedSatelliteDomain =
    normalizeClerkProductionSatelliteDomain(satelliteDomain);
  return isDomainOrSubdomain(normalizedHostname, normalizedSatelliteDomain)
    ? normalizedSatelliteDomain
    : null;
}
