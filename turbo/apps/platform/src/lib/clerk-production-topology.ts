const OKOU_CLERK_PRIMARY_APP_ORIGIN = "https://app.okou.ai";
export const VM0_CLERK_PRIMARY_APP_ORIGIN = "https://app.vm0.ai";

const CLERK_PRIMARY_USER_PROFILE_URL = "https://accounts.vm0.ai/user";

export type ClerkProductionDomain = "vm0.ai";

interface ClerkProductionTopology {
  readonly primaryAppOrigin: typeof OKOU_CLERK_PRIMARY_APP_ORIGIN;
  readonly primaryUserProfileUrl: typeof CLERK_PRIMARY_USER_PROFILE_URL;
  readonly primaryBrand: "okou";
}

function isDomainOrSubdomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

// Okou owns primary auth and the whole vm0.ai domain is a satellite. The Clerk
// instance and publishable key remain on clerk.vm0.ai.
//
// Keep this in sync with the inline Clerk bootstrap in `index.html`, which
// repeats it in the page itself so authentication starts before the app module
// loads.
export function resolveClerkProductionTopology(): ClerkProductionTopology {
  return {
    primaryAppOrigin: OKOU_CLERK_PRIMARY_APP_ORIGIN,
    primaryBrand: "okou",
    primaryUserProfileUrl: CLERK_PRIMARY_USER_PROFILE_URL,
  };
}

export function resolveClerkProductionSatelliteDomain(
  hostname: string,
): ClerkProductionDomain | null {
  return isDomainOrSubdomain(hostname.toLowerCase(), "vm0.ai")
    ? "vm0.ai"
    : null;
}
