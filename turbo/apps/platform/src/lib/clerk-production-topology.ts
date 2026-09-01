import { parsePublishableKey } from "@clerk/shared/keys";

export const OKOU_CLERK_PRIMARY_APP_ORIGIN = "https://app.okou.ai";
export const VM0_CLERK_PRIMARY_APP_ORIGIN = "https://app.vm0.ai";

const OKOU_CLERK_FRONTEND_API = "clerk.app.okou.ai";
const OKOU_CLERK_PRIMARY_USER_PROFILE_URL = "https://accounts.app.okou.ai/user";
const VM0_CLERK_PRIMARY_USER_PROFILE_URL = "https://accounts.vm0.ai/user";

export type ClerkProductionDomain = "app.okou.ai" | "vm0.ai";

interface ClerkProductionTopology {
  readonly primaryAppOrigin:
    | typeof OKOU_CLERK_PRIMARY_APP_ORIGIN
    | typeof VM0_CLERK_PRIMARY_APP_ORIGIN;
  readonly primaryUserProfileUrl:
    | typeof OKOU_CLERK_PRIMARY_USER_PROFILE_URL
    | typeof VM0_CLERK_PRIMARY_USER_PROFILE_URL;
  readonly primaryBrand: "okou" | "vm0";
}

function isDomainOrSubdomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

// The production domain change generates a new publishable key whose decoded
// Frontend API hostname identifies the active primary. Keeping the legacy VM0
// fallback makes the same artifact safe before the cutover and during rollback.
export function resolveClerkProductionTopology(
  publishableKey: string,
): ClerkProductionTopology {
  const frontendApi = parsePublishableKey(publishableKey)?.frontendApi;
  if (frontendApi === OKOU_CLERK_FRONTEND_API) {
    return {
      primaryAppOrigin: OKOU_CLERK_PRIMARY_APP_ORIGIN,
      primaryBrand: "okou",
      primaryUserProfileUrl: OKOU_CLERK_PRIMARY_USER_PROFILE_URL,
    };
  }

  return {
    primaryAppOrigin: VM0_CLERK_PRIMARY_APP_ORIGIN,
    primaryBrand: "vm0",
    primaryUserProfileUrl: VM0_CLERK_PRIMARY_USER_PROFILE_URL,
  };
}

export function resolveClerkProductionSatelliteDomain(
  hostname: string,
  publishableKey: string,
): ClerkProductionDomain | null {
  const normalizedHostname = hostname.toLowerCase();
  const topology = resolveClerkProductionTopology(publishableKey);

  if (topology.primaryBrand === "okou") {
    return isDomainOrSubdomain(normalizedHostname, "vm0.ai") ? "vm0.ai" : null;
  }

  return isDomainOrSubdomain(normalizedHostname, "app.okou.ai")
    ? "app.okou.ai"
    : null;
}
