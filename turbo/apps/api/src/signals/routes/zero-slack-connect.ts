import { computed } from "ccstate";
import { zeroSlackConnectContract } from "@vm0/api-contracts/contracts/zero-slack-connect";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { zeroSlackConnectStatus } from "../services/zero-slack-connect.service";
import type { RouteEntry } from "../route";

const getSlackConnectStatusInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const body = await get(
    zeroSlackConnectStatus({
      orgId: auth.orgId,
      userId: auth.userId,
      isAdmin: "orgRole" in auth && auth.orgRole === "admin",
    }),
  );
  return { status: 200 as const, body };
});

export const zeroSlackConnectRoutes: readonly RouteEntry[] = [
  {
    route: zeroSlackConnectContract.getStatus,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      getSlackConnectStatusInner$,
    ),
  },
];
