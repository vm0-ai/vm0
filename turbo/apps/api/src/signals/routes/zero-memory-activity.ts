import { computed } from "ccstate";
import { zeroMemoryActivityContract } from "@vm0/api-contracts/contracts/zero-memory-activity";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import type { RouteEntry } from "../route";
import { zeroMemoryActivity } from "../services/zero-memory-activity.service";

const memoryAuthOptions = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const getMemoryActivityInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  const activity = await get(zeroMemoryActivity(auth.orgId, auth.userId));
  return {
    status: 200 as const,
    body: activity,
  };
});

export const zeroMemoryActivityRoutes: readonly RouteEntry[] = [
  {
    route: zeroMemoryActivityContract.get,
    handler: authRoute(memoryAuthOptions, getMemoryActivityInner$),
  },
];
