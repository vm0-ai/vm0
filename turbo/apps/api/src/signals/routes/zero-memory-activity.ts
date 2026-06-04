import { computed } from "ccstate";
import { zeroMemoryActivityContract } from "@vm0/api-contracts/contracts/zero-memory-activity";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import type { RouteEntry } from "../route";
import { zeroMemoryActivity } from "../services/zero-memory-activity.service";

const memoryAuthOptions = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const memoryActivityQuery$ = queryOf(zeroMemoryActivityContract.get);

const getMemoryActivityInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  const query = get(memoryActivityQuery$);
  const activity = await get(
    zeroMemoryActivity({
      orgId: auth.orgId,
      userId: auth.userId,
      limit: query.limit,
      cursor: query.cursor,
    }),
  );
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
