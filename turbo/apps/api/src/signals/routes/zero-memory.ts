import { computed } from "ccstate";
import { zeroMemoryContract } from "@vm0/api-contracts/contracts/zero-memory";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import type { RouteEntry } from "../route";
import { zeroMemoryDetail } from "../services/zero-memory-detail.service";

const memoryAuthOptions = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const getMemoryInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  const detail = await get(zeroMemoryDetail(auth.orgId, auth.userId));
  return {
    status: 200 as const,
    body: detail,
  };
});

export const zeroMemoryRoutes: readonly RouteEntry[] = [
  {
    route: zeroMemoryContract.get,
    handler: authRoute(memoryAuthOptions, getMemoryInner$),
  },
];
