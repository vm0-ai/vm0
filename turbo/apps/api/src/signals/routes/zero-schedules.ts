import { computed } from "ccstate";
import { zeroSchedulesMainContract } from "@vm0/api-contracts/contracts/zero-schedules";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { zeroScheduleList } from "../services/zero-schedules.service";
import type { RouteEntry } from "../route";

const listSchedulesInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const result = await get(
    zeroScheduleList({ orgId: auth.orgId, userId: auth.userId }),
  );
  return { status: 200 as const, body: result };
});

export const zeroSchedulesRoutes: readonly RouteEntry[] = [
  {
    route: zeroSchedulesMainContract.list,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "schedule:read",
      },
      listSchedulesInner$,
    ),
  },
];
