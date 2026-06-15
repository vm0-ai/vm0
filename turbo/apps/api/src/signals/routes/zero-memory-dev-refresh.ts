import { zeroMemoryDevRefreshContract } from "@vm0/api-contracts/contracts/zero-memory-dev-refresh";
import { isStaffOrg } from "@vm0/core/staff-org";
import { command } from "ccstate";

import { env } from "../../lib/env";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import type { RouteEntry } from "../route";
import { summarizeMemoryForUser$ } from "../services/cron-summarize-memory.service";

const memoryDevRefreshAuthOptions = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

function canUseMemoryDevRefresh(orgId: string): boolean {
  return env("ENV") === "development" || isStaffOrg(orgId);
}

function memoryDevRefreshForbiddenResponse() {
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

const refreshMemoryInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (!canUseMemoryDevRefresh(auth.orgId)) {
      return memoryDevRefreshForbiddenResponse();
    }

    const body = await set(
      summarizeMemoryForUser$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        force: true,
      },
      signal,
    );
    signal.throwIfAborted();

    return { status: 200 as const, body };
  },
);

export const zeroMemoryDevRefreshRoutes: readonly RouteEntry[] = [
  {
    route: zeroMemoryDevRefreshContract.refresh,
    handler: authRoute(memoryDevRefreshAuthOptions, refreshMemoryInner$),
  },
];
