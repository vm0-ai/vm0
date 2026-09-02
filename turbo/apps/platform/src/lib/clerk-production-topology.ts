export const OKOU_CLERK_PRIMARY_APP_ORIGIN = "https://app.okou.ai";
export const VM0_CLERK_PRIMARY_APP_ORIGIN = "https://app.vm0.ai";

export const CURRENT_CLERK_PRODUCTION_PRIMARY_APP_DOMAIN = "app.vm0.ai";
export const CUTOVER_CLERK_PRODUCTION_PRIMARY_APP_DOMAIN = "app.okou.ai";
const OKOU_WORKER_CANARY_APP_DOMAIN = "app-worker.okou.ai";
const CLERK_PRIMARY_USER_PROFILE_URL = "https://accounts.vm0.ai/user";

export type ClerkProductionDomain =
  | "app.okou.ai"
  | typeof OKOU_WORKER_CANARY_APP_DOMAIN
  | "vm0.ai";
export type ClerkProductionPrimaryAppDomain =
  | typeof CURRENT_CLERK_PRODUCTION_PRIMARY_APP_DOMAIN
  | typeof CUTOVER_CLERK_PRODUCTION_PRIMARY_APP_DOMAIN;

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

export function normalizeClerkProductionPrimaryAppDomain(
  value: unknown,
): ClerkProductionPrimaryAppDomain {
  // Web/app rollout fallback: production clients and retained rollback builds
  // can straddle the Clerk primary/satellite cutover for about two days.
  // Remove the VM0-primary branch only after #27750 records that replacement
  // builds are live, auth verification passed, and the rollback gate closed.
  return value === CUTOVER_CLERK_PRODUCTION_PRIMARY_APP_DOMAIN
    ? CUTOVER_CLERK_PRODUCTION_PRIMARY_APP_DOMAIN
    : CURRENT_CLERK_PRODUCTION_PRIMARY_APP_DOMAIN;
}

// The Clerk instance and publishable key remain on clerk.vm0.ai. The explicit
// primary-app deployment value is the source of truth for which app owns
// primary auth. Unknown values fail closed to the currently deployed topology.
export function resolveClerkProductionTopology(
  primaryAppDomain: unknown,
): ClerkProductionTopology {
  if (
    normalizeClerkProductionPrimaryAppDomain(primaryAppDomain) ===
    CUTOVER_CLERK_PRODUCTION_PRIMARY_APP_DOMAIN
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
  primaryAppDomain: unknown,
): ClerkProductionDomain | null {
  const normalizedHostname = hostname.toLowerCase();
  if (
    normalizeClerkProductionPrimaryAppDomain(primaryAppDomain) ===
    CUTOVER_CLERK_PRODUCTION_PRIMARY_APP_DOMAIN
  ) {
    return isDomainOrSubdomain(normalizedHostname, "vm0.ai") ? "vm0.ai" : null;
  }

  if (isDomainOrSubdomain(normalizedHostname, "app.okou.ai")) {
    return "app.okou.ai";
  }
  return isDomainOrSubdomain(normalizedHostname, OKOU_WORKER_CANARY_APP_DOMAIN)
    ? OKOU_WORKER_CANARY_APP_DOMAIN
    : null;
}
