const OKOU_CLERK_PRIMARY_APP_ORIGIN = "https://app.okou.ai";
export const VM0_CLERK_PRIMARY_APP_ORIGIN = "https://app.vm0.ai";

// The deployed topology: Okou owns primary auth and the whole vm0.ai domain is
// a satellite. Everything except an explicit rollback request resolves here.
const DEFAULT_CLERK_PRODUCTION_PRIMARY_APP_DOMAIN = "app.okou.ai";
// The pre-cutover topology, kept reachable so a rollback is a change to the
// injected deployment value rather than a code change.
const ROLLBACK_CLERK_PRODUCTION_PRIMARY_APP_DOMAIN = "app.vm0.ai";
const CLERK_PRIMARY_USER_PROFILE_URL = "https://accounts.vm0.ai/user";

export type ClerkProductionDomain = "app.okou.ai" | "vm0.ai";
export type ClerkProductionPrimaryAppDomain =
  | typeof DEFAULT_CLERK_PRODUCTION_PRIMARY_APP_DOMAIN
  | typeof ROLLBACK_CLERK_PRODUCTION_PRIMARY_APP_DOMAIN;

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

// Keep this decision in sync with the inline Clerk bootstrap in `index.html`,
// which repeats it in the page itself so authentication starts before the app
// module loads.
export function normalizeClerkProductionPrimaryAppDomain(
  value: unknown,
): ClerkProductionPrimaryAppDomain {
  // Rollback path: an explicit rollback value must keep resolving to the
  // pre-cutover topology. Remove that branch only after #27750 records that
  // replacement builds are live, auth verification passed, and the rollback
  // gate closed.
  return value === ROLLBACK_CLERK_PRODUCTION_PRIMARY_APP_DOMAIN
    ? ROLLBACK_CLERK_PRODUCTION_PRIMARY_APP_DOMAIN
    : DEFAULT_CLERK_PRODUCTION_PRIMARY_APP_DOMAIN;
}

// The Clerk instance and publishable key remain on clerk.vm0.ai. The explicit
// primary-app deployment value is the source of truth for which app owns
// primary auth. Unknown values fail closed to the deployed topology, because a
// build that lost the injected value must not send clients to an app that no
// longer holds the session.
export function resolveClerkProductionTopology(
  primaryAppDomain: unknown,
): ClerkProductionTopology {
  if (
    normalizeClerkProductionPrimaryAppDomain(primaryAppDomain) ===
    ROLLBACK_CLERK_PRODUCTION_PRIMARY_APP_DOMAIN
  ) {
    return {
      primaryAppOrigin: VM0_CLERK_PRIMARY_APP_ORIGIN,
      primaryBrand: "vm0",
      primaryUserProfileUrl: CLERK_PRIMARY_USER_PROFILE_URL,
    };
  }

  return {
    primaryAppOrigin: OKOU_CLERK_PRIMARY_APP_ORIGIN,
    primaryBrand: "okou",
    primaryUserProfileUrl: CLERK_PRIMARY_USER_PROFILE_URL,
  };
}

export function resolveClerkProductionSatelliteDomain(
  hostname: string,
  primaryAppDomain: unknown,
): ClerkProductionDomain | null {
  const normalizedHostname = hostname.toLowerCase();
  if (
    normalizeClerkProductionPrimaryAppDomain(primaryAppDomain) ===
    ROLLBACK_CLERK_PRODUCTION_PRIMARY_APP_DOMAIN
  ) {
    return isDomainOrSubdomain(normalizedHostname, "app.okou.ai")
      ? "app.okou.ai"
      : null;
  }

  return isDomainOrSubdomain(normalizedHostname, "vm0.ai") ? "vm0.ai" : null;
}
