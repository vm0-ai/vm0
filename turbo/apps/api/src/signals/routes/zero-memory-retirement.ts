import { zeroMemoryContract } from "@vm0/api-contracts/contracts/zero-memory";
import { zeroMemoryActivityContract } from "@vm0/api-contracts/contracts/zero-memory-activity";
import { zeroMemoryDevRefreshContract } from "@vm0/api-contracts/contracts/zero-memory-dev-refresh";
import { MEMORY_ARTIFACT_NAME } from "@vm0/core/storage-names";
import { isStaffOrg } from "@vm0/core/staff-org";
import { command } from "ccstate";

import { env } from "../../lib/env";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import type { RouteEntry } from "../route-entry";

const memoryAuthOptions = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const getRetiredMemory$ = command(() => {
  return {
    status: 200 as const,
    body: {
      exists: false,
      name: MEMORY_ARTIFACT_NAME,
      size: 0,
      fileCount: 0,
      updatedAt: null,
      files: [],
      fileContents: [],
    },
  };
});

const getRetiredMemoryActivity$ = command(() => {
  return {
    status: 200 as const,
    body: {
      entries: [],
      nextCursor: null,
    },
  };
});

const refreshRetiredMemory$ = command(({ get }) => {
  const auth = get(organizationAuthContext$);
  if (env("ENV") !== "development" && !isStaffOrg(auth.orgId)) {
    return {
      status: 403 as const,
      body: {
        error: {
          message: "Memory dev refresh is only available to staff",
          code: "FORBIDDEN",
        },
      },
    };
  }

  return {
    status: 200 as const,
    body: { skipped: true as const },
  };
});

/**
 * Old browser tabs may keep the retired Memory page running after the new
 * frontend is deployed. Keep inert, response-compatible endpoints until those
 * clients have drained; none of these handlers reads memory or activity data.
 */
export const zeroMemoryRetirementRoutes: readonly RouteEntry[] = [
  {
    route: zeroMemoryContract.get,
    handler: authRoute(memoryAuthOptions, getRetiredMemory$),
  },
  {
    route: zeroMemoryActivityContract.get,
    handler: authRoute(memoryAuthOptions, getRetiredMemoryActivity$),
  },
  {
    route: zeroMemoryDevRefreshContract.refresh,
    handler: authRoute(memoryAuthOptions, refreshRetiredMemory$),
  },
];
