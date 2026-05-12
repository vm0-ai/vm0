import { computed } from "ccstate";
import { zeroOrgLogoContract } from "@vm0/api-contracts/contracts/zero-org-logo";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { clerk$ } from "../external/clerk";
import { safeAsync } from "../utils";
import type { RouteEntry } from "../route";

const orgLogoNotFound = Object.freeze({
  status: 404 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Org not found",
      code: "BAD_REQUEST",
    }),
  }),
});

function isOrgLookupNotFound(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.name === "BadRequestError" || error.name === "NotFoundError")
  );
}

const getOrgLogoInner$ = computed(async (get) => {
  const auth = get(authContext$);
  if (!auth.orgId) {
    return orgLogoNotFound;
  }

  const client = get(clerk$);
  const result = await safeAsync(() => {
    return client.organizations.getOrganization({
      organizationId: auth.orgId,
    });
  });

  if ("error" in result) {
    if (isOrgLookupNotFound(result.error)) {
      return orgLogoNotFound;
    }
    throw result.error;
  }

  return {
    status: 200 as const,
    body: {
      logoUrl: result.ok.imageUrl || null,
      hasImage: result.ok.hasImage,
    },
  };
});

export const zeroOrgLogoRoutes: readonly RouteEntry[] = [
  {
    route: zeroOrgLogoContract.get,
    handler: authRoute({}, getOrgLogoInner$),
  },
];
